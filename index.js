const fs = require("fs");
const path = require("path");
const stream = require("stream");
const util = require("util");
const forge = require("node-forge");
const archiver = require("archiver");
const moment = require("moment");
const schema = require("./schema");
const fields = require("./fields");
const { errors, warnings } = require("./messages");

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);

class Pass {
	constructor(options) {
		this.options = options;
		this.Certificates = {};
		this.model = "";
		this.l10n = {};
		this.props = {};
		this.shouldOverwrite = !(this.options.hasOwnProperty("shouldOverwrite") && !this.options.shouldOverwrite);

		fields.areas.forEach(a => this[a] = new fields.FieldsArea());
	}

	/**
	 * Generates the pass Stream
	 *
	 * @async
	 * @method generate
	 * @return {Promise<Stream>} A Promise containing the stream of the generated pass.
	*/

	generate() {
		let archive = archiver("zip");

		return this._parseSettings(this.options)
			.then(() => readdir(this.model))
			.catch((err) => {
				// May have not used this catch but ENOENT error is not enough self-explanatory in the case of external usage
				if (err.code && err.code === "ENOENT") {
					throw new Error(errors.NOT_FOUND.replace("%s", (this.model ? this.model+" " : "")));
				}

				throw new Error(err);
			})
			.then(files => {
				// list without dynamic components like manifest, signature or pass files (will be added later in the flow) and hidden files.
				let noDynList = removeHidden(files).filter(f => !/(manifest|signature|pass)/i.test(f));

				if (!noDynList.length || !noDynList.some(f => f.toLowerCase().includes("icon"))) {
					throw new Error(errors.UNINITIALIZED.replace("%s", path.parse(this.model).name));
				}

				// list without localization files (they will be added later in the flow)
				let bundle = noDynList.filter(f => !f.includes(".lproj"));

				// Localization folders only
				const L10N = noDynList.filter(f => f.includes(".lproj") && Object.keys(this.l10n).includes(path.parse(f).name));

				/**
				 * Reads pass.json file and apply patches on it
				 * @function
				 * @name passExtractor
				 * @return {Promise<Buffer>} The patched pass.json buffer
				 */

				let passExtractor = (() => {
					return readFile(path.resolve(this.model, "pass.json"))
						.then(passStructBuffer => {
							if (!this._validateType(passStructBuffer)) {
								throw new Error(errors.VALIDATION_FAILED)
							}

							bundle.push("pass.json");

							return this._patch(passStructBuffer);
						});
				});

				/*
				 * Reading all the localization selected folders and removing hidden files (the ones that starts with ".")
				 * from the list. Returning a Promise containing all those files
				 */

				return Promise.all(L10N.map(f => readdir(path.join(this.model, f)).then(removeHidden)))
					.then(listByFolder => {

						/* Each file name is joined with its own path and pushed to the bundle files array. */

						listByFolder.forEach((folder, index) => bundle.push(...folder.map(f => path.join(L10N[index], f))));

						/* Getting all bundle file buffers, pass.json included, and appending */

						let bundleBuffers = bundle.map(f => readFile(path.resolve(this.model, f)));
						let passBuffer = passExtractor();

						return Promise.all([...bundleBuffers, passBuffer])
							.then(buffers => {
								Object.keys(this.l10n).forEach(l => {
									const strings = this._generateStringFile(l);

									/*
									 * if .string file buffer is empty, no translations were added
									 * but still wanted to include the language
									 */

									if (strings.length) {
										buffers.push(strings);
										bundle.push(path.join(`${l}.lproj`, `pass.strings`));
									}
								});

								return [buffers, bundle];
							});
					});
			})
			.then(([buffers, bundle]) => {
				/*
				 * Parsing the buffers, pushing them into the archive
				 * and returning the compiled manifest
				 */

				return buffers.reduce((acc, current, index) => {
					let filename = bundle[index];
					let hashFlow = forge.md.sha1.create();

					hashFlow.update(current.toString("binary"));
					archive.append(current, { name: filename });

					acc[filename] = hashFlow.digest().toHex();

					return acc;
				}, {});
			})
			.then((manifest) => {
				let signatureBuffer = this._sign(manifest);

				archive.append(signatureBuffer, { name: "signature" });
				archive.append(JSON.stringify(manifest), { name: "manifest.json" });

				let passStream = new stream.PassThrough();

				archive.pipe(passStream);

				return archive.finalize().then(() => passStream);
			});
	}

	/**
	 * Adds traslated strings object to the list of translation to be inserted into the pass
	 *
	 * @method localize
	 * @params {String} lang - the ISO 3166 alpha-2 code for the language
	 * @params {Object} translations - key/value pairs where key is the
	 * 		string appearing in pass.json and value the translated string
	 * @returns {this}
	 *
	 * @see https://apple.co/2KOv0OW - Passes support localization
	 */

	localize(lang, translations) {
		if (typeof translations === "object") {
			this.l10n[lang] = translations;
		}

		return this;
	}

	/**
	 * Creates a buffer of translations in Apple .strings format
	 *
	 * @method _generateStringFile
	 * @params {String} lang - the ISO 3166 alpha-2 code for the language
	 * @returns {Buffer} Buffer to be written in pass.strings for language in lang
	 * @see https://apple.co/2M9LWVu - String Resources
	 */

	_generateStringFile(lang) {
		if (!Object.keys(this.l10n[lang]).length) {
			return Buffer.from("", "utf8");
		}

		let strings = Object.keys(this.l10n[lang]).map(key => `"${key}" = "${this.l10n[lang][key].replace(/"/g, /\\"/)}";`);
		return Buffer.from(strings.join("\n"), "utf8");
	}

	/**
	 * Sets expirationDate property to the W3C date
	 *
	 * @method expiration
	 * @params {String} date - the date in string
	 * @returns {this}
	 */

	expiration(date) {
		if (typeof date !== "string") {
			return this;
		}

		const convDate = dateToW3CString(date);

		if (convDate) {
			this.props.expirationDate = convDate;
		}

		return this;
	}

	/**
	 * Sets voided property to true
	 *
	 * @method void
	 * @return {this}
	 */

	void() {
		this.props.voided = true;
		return this;
	}

	/**
	 * Checks and sets data for "beacons", "locations", "maxDistance" and "relevantDate" keys
	 *
	 * @method relevance
	 * @params {String} type - one of the key above
	 * @params {Any[]} data - the data to be pushed to the property
	 * @return {Number} The quantity of data pushed
	 */

	relevance(type, data) {
		let types = ["beacons", "locations", "maxDistance", "relevantDate"];

		if (!type || !data || !types.includes(type)) {
			return Object.assign({
				length: 0
			}, this);
		}

		if (type === "beacons" || type === "locations") {
			if (!(data instanceof Array)) {
				data = [data];
			}

			let valid = data.filter(d => schema.isValid(d, schema.constants[type+"Dict"]));
			this.props[type] = valid;

			return Object.assign({
				length: valid.length
			}, this);
		}

		if (type === "maxDistance" && (typeof data === "string" || typeof data === "number")) {
			this.props[type] = Number(data);

			return Object.assign({
				length: 1
			}, this);
		} else if (type === "relevantDate") {
			let convDate = dateToW3CString(data);

			if (convDate) {
				this.props[type] = convDate;
			}

			return Object.assign({
				length: Number(!!convDate)
			}, this);
		}
	}

	/**
	 * Adds barcodes to "barcode" and "barcodes" properties.
	 * It will let later to add the missing versions
	 *
	 * @method barcode
	 * @params {Object|String} data - the data to be added
	 * @return {this} Improved this with length property and other methods
	 */

	barcode(data) {
		if (!data) {
			return Object.assign({
				length: 0,
				autocomplete: () => {},
				backward: () => {}
			}, this);
		}

		if (typeof data === "string" || (data instanceof Object && !data.format && data.message)) {
			let autogen = this.__barcodeAutogen(data instanceof Object ? data : { message: data });

			this.props["barcode"] = autogen[0] || {};
			this.props["barcodes"] = autogen || [];

			return Object.assign({
				length: 4,
				autocomplete: () => {},
				backward: this.__barcodeChooseBackward.bind(this)
			}, this);
		}

		if (!(data instanceof Array)) {
			data = [data];
		}

		let valid = data.filter(b => {
			if (!(b instanceof Object)) {
				return false;
			}

			// messageEncoding is required
			b.messageEncoding = b.messageEncoding || "iso-8859-1";

			return schema.isValid(b, schema.constants.barcode);
		});

		this.props["barcode"] = valid[0] || {};
		this.props["barcodes"] = valid || [];

		return Object.assign({
			length: valid.length,
			autocomplete: this.__barcodeAutocomplete.bind(this),
			backward: this.__barcodeChooseBackward.bind(this)
		}, this);
	}

	/**
	 * Automatically generates barcodes for all the types given common info
	 *
	 * @method __barcodeAutogen
	 * @params {Object} data - common info, may be object or the message itself
	 * @params {String} data.message - the content to be placed inside "message" field
	 * @params {String} [data.altText=data.message] - alternativeText, is message content if not overwritten
	 * @params {String} [data.messageEncoding=iso-8859-1] - the encoding
	 * @return {Object[]} Object array barcodeDict compliant
	 */

	__barcodeAutogen(data) {
		if (!data || !(data instanceof Object) || !data.message) {
			return [];
		}

		let types = ["PKBarcodeFormatQR", "PKBarcodeFormatPDF417", "PKBarcodeFormatAztec", "PKBarcodeFormatCode128"];

		data.altText = data.altText || data.message;
		data.messageEncoding = data.messageEncoding || "iso-8859-1";
		delete data.format;

		return types.map(T => Object.assign({ format: T }, data));
	}

	/**
	 * Given an already compiled props["barcodes"] with missing objects
	 * (less than 4), takes infos from the first object and replicate them
	 * in the missing structures.
	 *
	 * @method __barcodeAutocomplete
	 * @returns {this} Improved this, with length property and retroCompatibility method.
	 */

	__barcodeAutocomplete() {
		let props = this.props["barcodes"];

		if (props.length === 4 || !props.length) {
			return Object.assign({
				length: 0,
				backward: this.__barcodeChooseBackward.bind(this)
			}, this);
		}

		this.props["barcodes"] = this.__barcodeAutogen(props[0]);

		return Object.assign({
			length: 4,
			backward: this.__barcodeChooseBackward.bind(this)
		}, this);
	}

	/**
	 * Given an index <= the amount of already set "barcodes",
	 * this let you choose which structure to use for retrocompatibility
	 * property "barcode".
	 *
	 * @method __barcodeChooseBackward
	 * @params {String} format - the format, or part of it, to be used
	 * @return {this}
	 */

	__barcodeChooseBackward(format) {
		if (format === null) {
			this.props["barcode"] = undefined;
			return this;
		}

		if (typeof format !== "string") {
			return this;
		}

		let index = this.props["barcodes"].findIndex(b => b.format.toLowerCase().includes(format.toLowerCase()));

		if (index === -1) {
			return this;
		}

		this.props["barcode"] = this.props["barcodes"][index];

		return this;
	}

	/**
	 * Checks if pass model type is one of the supported ones
	 *
	 * @method _validateType
	 * @params {Buffer} passBuffer - buffer of the pass structure content
	 * @returns {Boolean} true if type is supported, false otherwise.
	 */

	_validateType(passBuffer) {
		let passTypes = ["boardingPass", "eventTicket", "coupon", "generic", "storeCard"];

		try {
			let passFile = JSON.parse(passBuffer.toString("utf8"));
			let index = passTypes.findIndex(passType => passFile.hasOwnProperty(passType));

			if (index == -1) {
				return false;
			}

			let type = passTypes[index];

			this.type = type;
			return schema.isValid(passFile[type], schema.constants[(type === "boardingPass" ? "boarding" : "basic") + "Structure"]);
		} catch (e) {
			return false;
		}
	}

	/**
	 * Generates the PKCS #7 cryptografic signature for the manifest file.
	 *
	 * @method _sign
	 * @params {String|Object} manifest - Manifest content.
	 * @returns {Buffer}
	 */

	_sign(manifest) {
		let signature = forge.pkcs7.createSignedData();

		if (typeof manifest === "object") {
			signature.content = forge.util.createBuffer(JSON.stringify(manifest), "utf8");
		} else if (typeof manifest === "string") {
			signature.content = manifest;
		} else {
			throw new Error(errors.MANIFEST_TYPE.replace("%s", typeof manifest));
		}

		signature.addCertificate(this.Certificates.wwdr);
		signature.addCertificate(this.Certificates.signerCert);

		signature.addSigner({
			key: this.Certificates.signerKey,
			certificate: this.Certificates.signerCert,
			digestAlgorithm: forge.pki.oids.sha1,
			authenticatedAttributes: [{
				type: forge.pki.oids.contentType,
				value: forge.pki.oids.data
			}, {
				type: forge.pki.oids.messageDigest,
			}, {
				// the value is autogenerated
				type: forge.pki.oids.signingTime,
			}]
		});

		signature.sign();

		/*
		 * Signing creates in contentInfo a JSON object nested BER/TLV (X.690 standard) structure.
		 * Each object represents a component of ASN.1 (Abstract Syntax Notation)
		 * For a more complete reference, refer to: https://en.wikipedia.org/wiki/X.690#BER_encoding
		 *
		 * signature.contentInfo.type => SEQUENCE OF (16)
		 * signature.contentInfo.value[0].type => OBJECT IDENTIFIER (6)
		 * signature.contantInfo.value[1].type => END OF CONTENT (EOC - 0)
		 *
		 * EOC are only present only in constructed indefinite-length methods
		 * Since `signature.contentInfo.value[1].value` contains an object whose value contains the content we passed,
		 * we have to pop the whole object away to avoid signature content invalidation.
		 *
		 */
		signature.contentInfo.value.pop();

		// Converting the JSON Structure into a DER (which is a subset of BER), ASN.1 valid structure
		// Returning the buffer of the signature

		return Buffer.from(forge.asn1.toDer(signature.toAsn1()).getBytes(), "binary");
	}

	/**
	 * Edits the buffer of pass.json based on the passed options.
	 *
	 * @method _patch
	 * @params {Object} options - options resulting from the filtering made by filterPassOptions function
	 * @params {Buffer} passBuffer - Buffer of the contents of pass.json
	 * @returns {Promise<Buffer>} Edited pass.json buffer or Object containing error.
	 */

	_patch(passBuffer) {
		if (!Object.keys(this.props).length) {
			return Promise.resolve(passBuffer);
		}

		const rgbValues = ["backgroundColor", "foregroundColor", "labelColor"];
		let passFile = JSON.parse(passBuffer.toString("utf8"));

		rgbValues.filter(v => this.props[v] && !isValidRGB(this.props[v])).forEach(v => delete this.props[v]);

		if (this.shouldOverwrite) {
			Object.assign(passFile, this.props);
		} else {
			Object.keys(this.props).forEach(prop => {
				if (passFile[prop]) {
					if (passFile[prop] instanceof Array) {
						passFile[prop].push(...this.props[prop]);
					} else if (passFile[prop] instanceof Object) {
						Object.assign(passFile[prop], this.props[prop]);
					}
				} else {
					passFile[prop] = this.props[prop];
				}
			});
		}

		fields.areas.forEach(area => {
			if (this[area].fields.length) {
				passFile[this.type][area].push(...this[area].fields);
			}
		});

		return Promise.resolve(Buffer.from(JSON.stringify(passFile)));
	}

	/**
	 * Filters the options received in the query from http request into supported options
	 * by Apple and this application.
	 *
	 * @method _filterOptions
	 * @params {Object} opts - raw informations to be edited in the pass.json file
	 *							from HTTP Request Params or Body
	 * @returns {Object} - filtered options based on above criterias.
	 */

	_filterOptions(opts) {
		const forbidden = ["primaryFields", "secondaryFields", "auxiliaryFields", "backFields", "headerFields", "expirationDate", "voided", "locations", "beacons", "maxDistance", "relevantDate"];
		const supported = ["serialNumber", "userInfo", "authenticationToken", "barcode", "backgroundColor", "foregroundColor", "labelColor"];

		let valid = Object.keys(opts).filter(o => !forbidden.includes(o) && supported.includes(o));

		return Object.assign(...valid.map(v => ({ [v]: opts[v] })), {});
	}

	/**
	 * Validates the contents of the passed options and assigns the contents to the right properties
	 *
	 * @async
	 * @method _parseSettings
	 * @params {Object} options - the options passed to be parsed
	 * @returns {Promise}
	 */

	_parseSettings(options) {
		if (!schema.isValid(options, schema.constants.instance)) {
			throw new Error(errors.REQS_NOT_MET);
		}

		if (!options.model || typeof options.model !== "string") {
			throw new Error(errors.MODEL_NOT_STRING);
		}

		this.model = path.resolve(options.model) + (!!options.model && !path.extname(options.model) ? ".pass" : "");

		Object.assign(this.props, this._filterOptions(options.overrides));

		let certPaths = Object.keys(options.certificates)
			.map((val) => {
				const cert = options.certificates[val];
				const filePath = !(cert instanceof Object) ? cert : cert["keyFile"];
				const resolvedPath = path.resolve(filePath);

				return readFile(resolvedPath);
			});

		return Promise.all(certPaths).then(contents => {
			contents.forEach(file => {
				let pem = this.__parsePEM(file, options.certificates.signerKey.passphrase);
				if (!pem) {
					return reject(errors.INVALID_CERTS)
				}

				this.Certificates[pem.key] = pem.value;
			});
		});
	}

	/**
	 * Parses the PEM-formatted passed text (certificates)
	 *
	 * @method __parsePEM
	 * @params {String} element - Text content of .pem files
	 * @params {String} passphrase - passphrase for the key
	 * @returns {Object} - Object containing name of the certificate and its parsed content
	 */

	__parsePEM(element, passphrase) {
		if (element.includes("PRIVATE KEY") && !!passphrase) {
			return {
				key: "signerKey",
				value: forge.pki.decryptRsaPrivateKey(element, String(passphrase))
			};
		} else if (element.includes("CERTIFICATE")) {
			// PEM-exported certificates with keys are in PKCS#12 format, hence they are composed of bags.
			return {
				key: element.includes("Bag Attributes") ? "signerCert" : "wwdr",
				value: forge.pki.certificateFromPem(element)
			};
		} else {
			return {};
		}
	}
}

/**
 * Checks if an rgb value is compliant with CSS-like syntax
 *
 * @function isValidRGB
 * @params {String} value - string to analyze
 * @returns {Boolean} True if valid rgb, false otherwise
 */

function isValidRGB(value) {
	if (!value || typeof value !== "string") {
		return false;
	}

	let rgb = value.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/);

	if (!rgb) {
		return false;
	}

	return rgb.slice(1,4).every(v => Math.abs(Number(v)) <= 255);
}

/**
 * Converts a date to W3C Standard format
 *
 * @function dateToW3Cstring
 * @params {String}
 */

function dateToW3CString(date) {
	if (typeof date !== "string") {
		return "";
	}

	let parsedDate = moment(date, ["MM-DD-YYYY"]).format();

	if (parsedDate === "Invalid date") {
		return "";
	}

	return parsedDate;
}

/**
 *	Apply a filter to arg0 to remove hidden files names (starting with dot)
 *	@function removeHidden
 *	@params {String[]} from - list of file names
 *	@return {String[]}
 */

function removeHidden(from) {
	return from.filter(e => e.charAt(0) !== ".");
}

module.exports = { Pass };

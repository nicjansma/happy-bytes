/**
 * Compression helpers (gzip, brotli, zstd), with and without a dictionary, using Node's built-in zlib.
 */
import zlib from "node:zlib";

const C = zlib.constants;

/**
 * Compression Dictionary Transport framing overhead (RFC 9842):
 *  - dcb: 4-byte magic (ff 44 43 42) + 32-byte SHA-256 of the dictionary
 *  - dcz: 8-byte magic (skippable frame 5e 2a 4d 18 20 00 00 00) + 32-byte SHA-256
 */
export const DCB_HEADER_BYTES = 36;
export const DCZ_HEADER_BYTES = 40;

/**
 * Compressed sizes of a resource without a dictionary.
 *
 * @typedef {object} BaselineSizes
 * @property {number} original Uncompressed size
 * @property {number} gzip gzip size
 * @property {number} br Brotli size
 * @property {number} zstd Zstandard size
 */

/**
 * Compressed sizes of a resource with a dictionary, including dcb/dcz framing.
 *
 * @typedef {object} DictionarySizes
 * @property {number} brDict Brotli + dictionary size (dcb)
 * @property {number} zstdDict Zstandard + dictionary size (dcz)
 */

/**
 * Compresses with gzip.
 *
 * @param {Buffer} buf Data to compress
 * @param {object} [options] Options
 * @param {number} [options.level] gzip level, 1-9
 * @returns {Buffer} Compressed data
 */
export function gzip(buf, { level = 9 } = {}) {
    return zlib.gzipSync(buf, { level });
}

/**
 * Compresses with brotli, optionally using a raw (LZ77 prefix) dictionary.
 *
 * @param {Buffer} buf Data to compress
 * @param {object} [options] Options
 * @param {number} [options.quality] Brotli quality, 0-11
 * @param {Buffer} [options.dictionary] Raw dictionary
 * @returns {Buffer} Compressed data
 */
export function brotli(buf, { quality = 11, dictionary } = {}) {
    const params = {
        [C.BROTLI_PARAM_QUALITY]: quality,
        // Our inputs are HTML / JS / CSS
        [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_TEXT,
        // 16 MB window, the maximum for standard brotli and for dcb.
        [C.BROTLI_PARAM_LGWIN]: 24,
        // Lets the encoder tune itself to the input length
        [C.BROTLI_PARAM_SIZE_HINT]: buf.length
    };
    const opts = { params };

    // An empty dictionary is the same as no dictionary
    if (dictionary?.length) {
        opts.dictionary = dictionary;
    }

    return zlib.brotliCompressSync(buf, opts);
}

/**
 * Compresses with Zstandard, optionally using a raw-content dictionary.
 *
 * @param {Buffer} buf Data to compress
 * @param {object} [options] Options
 * @param {number} [options.level] Zstandard level, 1-22
 * @param {Buffer} [options.dictionary] Raw dictionary
 * @returns {Buffer} Compressed data
 */
export function zstd(buf, { level = 19, dictionary } = {}) {
    const params = { [C.ZSTD_c_compressionLevel]: level };

    // dcz decoders are only required to support windows up to 8 MB (windowLog 23).
    // Levels 20+ ("ultra") would otherwise use bigger windows.
    if (level > 19) {
        params[C.ZSTD_c_windowLog] = 23;
    }

    const opts = { params };

    // An empty dictionary is the same as no dictionary
    if (dictionary?.length) {
        opts.dictionary = dictionary;
    }

    return zlib.zstdCompressSync(buf, opts);
}

/**
 * Measures the compressed sizes of `body` without a dictionary.
 *
 * @param {Buffer} body Resource contents
 * @param {object} [options] Compression settings
 * @param {number} [options.gzipLevel] gzip level
 * @param {number} [options.brotliQuality] Brotli quality
 * @param {number} [options.zstdLevel] Zstandard level
 * @returns {BaselineSizes} Sizes in bytes
 */
export function measureBaseline(body, { gzipLevel = 9, brotliQuality = 11, zstdLevel = 19 } = {}) {
    return {
        original: body.length,
        gzip: gzip(body, { level: gzipLevel }).length,
        br: brotli(body, { quality: brotliQuality }).length,
        zstd: zstd(body, { level: zstdLevel }).length
    };
}

/**
 * Measures the compressed sizes of `body` with `dictionary`, including dcb/dcz framing.
 *
 * @param {Buffer} body Resource contents
 * @param {Buffer} dictionary Raw dictionary
 * @param {object} [options] Compression settings
 * @param {number} [options.brotliQuality] Brotli quality
 * @param {number} [options.zstdLevel] Zstandard level
 * @returns {DictionarySizes} Sizes in bytes
 */
export function measureWithDictionary(body, dictionary, { brotliQuality = 11, zstdLevel = 19 } = {}) {
    return {
        // The header is part of every dictionary-compressed response, so count it
        brDict: brotli(body, { quality: brotliQuality, dictionary }).length + DCB_HEADER_BYTES,
        zstdDict: zstd(body, { level: zstdLevel, dictionary }).length + DCZ_HEADER_BYTES
    };
}

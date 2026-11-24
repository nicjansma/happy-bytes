/**
 * Dictionary builders.
 *
 * `cover` is a JavaScript implementation of the approach used by zstd's
 * COVER / FASTCOVER trainers (Liao, Petri, Moffat, Wirth: "Effective
 * Construction of Relative Lempel-Ziv Dictionaries"):
 *
 *   1. Every d-byte substring ("dmer") of the training data is hashed.
 *   2. Each dmer gets a weight. Dmers that appear in many *different* resources
 *      score highest, since that is content the compressor can't find within
 *      the resource itself but can find in a shared dictionary. Repetition
 *      across distant 4 KB blocks of a single resource is a tie-breaker.
 *   3. The data is split into epochs. From each epoch the k-byte segment with
 *      the highest total weight of *distinct* dmers is picked, and those dmers'
 *      weights drop to zero so the same content isn't picked twice.
 *   4. Segments fill the dictionary from the end backwards, so the most
 *      valuable content gets the shortest match distances.
 *
 * Dictionaries produced here are "raw" (plain bytes, no zstd dictionary header),
 * which is what Compression Dictionary Transport (dcb / dcz) expects.
 *
 * `raw` concatenates the samples (truncated to the size limit). That's the
 * "use the previous version of the resource as the dictionary" approach. It works
 * well when a set holds a single resource that you deploy new versions of.
 */
import zlib from "node:zlib";

/**
 * A selected dictionary segment: byte range [begin, end) of the concatenated training data.
 *
 * @typedef {object} Segment
 * @property {number} begin Start offset (inclusive)
 * @property {number} end End offset (exclusive)
 * @property {number} score Total weight of the distinct dmers in the segment
 */

/**
 * COVER parameters.
 *
 * @typedef {object} CoverParams
 * @property {number} [k] Segment size in bytes
 * @property {number} [d] Dmer size in bytes
 */

// Default segment size (bytes copied into the dictionary per selection)
const DEFAULT_K = 1024;

// Default dmer size (length of the substrings that are hashed and scored)
const DEFAULT_D = 8;

// Block size used to count repetition within a single resource
const BLOCK_SIZE = 4096;

// Approximate number of passes over the data while filling the dictionary (as in zstd)
const PASSES = 4;

// Scale factor that makes each additional resource containing a dmer outweigh any amount of
// within-resource repetition (which is capped at WEIGHT_PER_DOC - 1)
const WEIGHT_PER_DOC = 16;

/**
 * Picks the hash table size (in bits) for the amount of training data.
 *
 * Bigger tables mean fewer hash collisions but more memory; 2^22 entries caps memory at
 * roughly 100 MB across all the per-dmer arrays.
 *
 * @param {number} totalSize Total training data size in bytes
 * @returns {number} Number of hash bits, between 16 and 22
 */
function hashTableBits(totalSize) {
    return Math.min(22, Math.max(16, Math.ceil(Math.log2(Math.max(2, totalSize)))));
}

/**
 * Hashes the dmer starting at every byte position of the training data.
 *
 * @param {Buffer} data Concatenated training data
 * @param {Array<[number, number]>} boundaries [start, end) offsets of each sample within `data`
 * @param {number} d Dmer size
 * @param {number} f Hash size in bits
 * @returns {Int32Array} Hash for each position, or -1 where the dmer would cross a sample boundary
 */
function computeHashes(data, boundaries, d, f) {
    const hashes = new Int32Array(data.length).fill(-1);

    // Keep the top f bits of the 32-bit hash (they're the best mixed)
    const shift = 32 - f;

    for (const [start, end] of boundaries) {
        // Only positions where a full dmer fits inside this sample
        for (let i = start; i + d <= end; i++) {
            // FNV-1a over the d bytes...
            let h = 0x811c9dc5;

            for (let j = 0; j < d; j++) {
                h = Math.imul(h ^ data[i + j], 0x01000193);
            }

            // ...followed by a murmur-style finalizer to spread the bits before truncating
            h ^= h >>> 15;
            h = Math.imul(h, 0x2c1b3c6d);
            h ^= h >>> 12;
            hashes[i] = h >>> shift;
        }
    }

    return hashes;
}

/**
 * Computes the weight (usefulness) of every dmer hash.
 *
 * weight = (number of samples containing it - 1) * WEIGHT_PER_DOC
 *        + min(extra 4 KB blocks containing it, WEIGHT_PER_DOC - 1)
 *
 * So a dmer found in only one place scores 0, cross-resource sharing dominates, and
 * repetition inside a single resource only breaks ties.
 *
 * @param {Int32Array} hashes Per-position dmer hashes from computeHashes()
 * @param {Array<[number, number]>} boundaries [start, end) offsets of each sample
 * @param {number} f Hash size in bits
 * @returns {Uint32Array} Weight per hash value
 */
function computeWeights(hashes, boundaries, f) {
    const size = 1 << f;

    // Number of distinct samples / blocks each hash appears in
    const docCount = new Uint32Array(size);
    const blockCount = new Uint32Array(size);

    // Last sample / block each hash was counted in, so each is counted at most once per sample / block
    const lastDoc = new Int32Array(size).fill(-1);
    const lastBlock = new Int32Array(size).fill(-1);

    // Global block numbering: each sample's blocks start after the previous sample's
    let blockBase = 0;

    boundaries.forEach(([start, end], doc) => {
        for (let i = start; i < end; i++) {
            const h = hashes[i];

            // No dmer here (crosses a sample boundary)
            if (h < 0) {
                continue;
            }

            const block = blockBase + Math.floor((i - start) / BLOCK_SIZE);

            if (lastDoc[h] !== doc) {
                lastDoc[h] = doc;
                docCount[h]++;
            }

            if (lastBlock[h] !== block) {
                lastBlock[h] = block;
                blockCount[h]++;
            }
        }

        // +1 leaves a gap so block numbers never collide between samples
        blockBase += Math.ceil((end - start) / BLOCK_SIZE) + 1;
    });

    const weights = new Uint32Array(size);

    for (let h = 0; h < size; h++) {
        if (docCount[h]) {
            // blockCount - docCount = blocks beyond the first one in each sample (in-sample repetition)
            weights[h] = (docCount[h] - 1) * WEIGHT_PER_DOC +
                Math.min(blockCount[h] - docCount[h], WEIGHT_PER_DOC - 1);
        }
    }

    return weights;
}

/**
 * Finds the best k-byte segment within [begin, end) of the training data, then zeroes the
 * weights of its dmers so later selections favor new content.
 *
 * Uses a sliding window: the score is the summed weight of the *distinct* dmers in the window,
 * tracked incrementally with a per-hash occurrence counter (`segFreq`).
 *
 * @param {Int32Array} hashes Per-position dmer hashes
 * @param {Uint32Array} weights Weight per hash (modified: the chosen dmers are zeroed)
 * @param {Uint32Array} segFreq Scratch counters; must be all zero on entry and is all zero on return
 * @param {number} begin Epoch start offset
 * @param {number} end Epoch end offset (exclusive)
 * @param {number} k Segment size
 * @param {number} d Dmer size
 * @returns {Segment|null} The best segment, or null if every window scores 0
 */
function selectSegment(hashes, weights, segFreq, begin, end, k, d) {
    let score = 0;
    let best = 0;
    let bestBegin = -1;
    let bestEnd = -1;

    // Window covers the dmers starting at positions [wBegin, pos]
    let wBegin = begin;

    // Last position where a whole dmer fits in the epoch
    const last = end - d;

    for (let pos = begin; pos <= last; pos++) {
        const h = hashes[pos];

        // Add the new dmer; it only adds to the score if it isn't already in the window
        if (h >= 0 && segFreq[h]++ === 0) {
            score += weights[h];
        }

        // Shrink from the left until the window's bytes (first dmer start .. last dmer end) fit in k
        while (pos + d - wBegin > k) {
            const hb = hashes[wBegin];

            // Remove the oldest dmer; it only subtracts if that was its last occurrence in the window
            if (hb >= 0 && --segFreq[hb] === 0) {
                score -= weights[hb];
            }

            wBegin++;
        }

        if (score > best) {
            best = score;
            bestBegin = wBegin;
            bestEnd = pos + d;
        }
    }

    // Reset the counters for the dmers still in the window, leaving segFreq all zero for the next call
    for (let p = wBegin; p <= last; p++) {
        const h = hashes[p];

        if (h >= 0) {
            segFreq[h] = 0;
        }
    }

    if (best === 0) {
        return null;
    }

    /**
     * Weight of the dmer starting at a position.
     *
     * @param {number} p Position in the training data
     * @returns {number} Weight (0 if there's no dmer there)
     */
    const weightAt = (p) => (hashes[p] >= 0 ? weights[hashes[p]] : 0);

    // Trim worthless dmers off both ends so the dictionary space isn't wasted
    while (bestBegin < bestEnd - d && weightAt(bestBegin) === 0) {
        bestBegin++;
    }

    while (bestEnd - d > bestBegin && weightAt(bestEnd - d) === 0) {
        bestEnd--;
    }

    // The dictionary now contains these dmers, so they're worth nothing to future segments
    for (let p = bestBegin; p <= bestEnd - d; p++) {
        const h = hashes[p];

        if (h >= 0) {
            weights[h] = 0;
        }
    }

    return { begin: bestBegin, end: bestEnd, score: best };
}

/**
 * Builds a dictionary from the content shared across samples (COVER algorithm, see the file header).
 *
 * @param {Buffer[]} samples Training data, one Buffer per resource
 * @param {object} options Options
 * @param {number} options.size Maximum dictionary size in bytes
 * @param {number} [options.k] Segment size in bytes
 * @param {number} [options.d] Dmer size in bytes
 * @returns {Buffer} Dictionary (at most `size` bytes; empty if nothing is repeated)
 * @throws {Error} If `size` isn't positive
 */
export function buildCoverDictionary(samples, { size, k = DEFAULT_K, d = DEFAULT_D } = {}) {
    if (!(size > 0)) {
        throw new Error("Dictionary size must be > 0");
    }

    // Samples shorter than a dmer contribute nothing
    samples = samples.filter((s) => s.length >= d);
    const total = samples.reduce((sum, s) => sum + s.length, 0);

    if (!total) {
        return Buffer.alloc(0);
    }

    // Work on one contiguous buffer, remembering where each sample starts and ends
    const data = Buffer.concat(samples, total);
    const boundaries = [];
    let offset = 0;

    for (const s of samples) {
        boundaries.push([offset, offset + s.length]);
        offset += s.length;
    }

    const f = hashTableBits(total);
    const hashes = computeHashes(data, boundaries, d, f);
    const weights = computeWeights(hashes, boundaries, f);
    const segFreq = new Uint32Array(1 << f);

    // Split the data into epochs so segments are drawn from all over the training data
    // (about PASSES rounds through every epoch to fill the dictionary), like zstd does.
    let epochs = Math.max(1, Math.floor(size / k / PASSES));
    let epochSize = Math.floor(total / epochs);
    const minEpochSize = k * 10;

    // With little data, use fewer, bigger epochs so each one has room for a meaningful search
    if (epochSize < minEpochSize) {
        epochs = Math.max(1, Math.floor(total / minEpochSize));
        epochSize = Math.floor(total / epochs);
    }

    // The dictionary is filled from the back: `tail` is the start of the filled region
    const dict = Buffer.alloc(size);
    let tail = size;

    // Consecutive epochs that had nothing left worth adding
    let zeroRun = 0;

    // Cycle round-robin through the epochs until the dictionary is full (or less than a dmer is left)
    for (let epoch = 0; tail >= d; epoch = (epoch + 1) % epochs) {
        const begin = epoch * epochSize;

        // The last epoch also takes the remainder of the integer division
        const end = epoch === epochs - 1 ? total : begin + epochSize;
        const segment = selectSegment(hashes, weights, segFreq, begin, end, k, d);

        if (!segment) {
            // Every epoch came up empty in a row: no useful content left anywhere
            if (++zeroRun >= epochs) {
                break;
            }

            continue;
        }

        zeroRun = 0;

        // Copy the segment just in front of the previous one (truncated if the dictionary is nearly full)
        const len = Math.min(segment.end - segment.begin, tail);

        tail -= len;
        data.copy(dict, tail, segment.begin, segment.begin + len);
    }

    // Return only the filled part; copy so the unused prefix of `dict` can be garbage collected
    return Buffer.from(dict.subarray(tail));
}

/**
 * Builds a dictionary by concatenating samples, in order, up to `size` bytes.
 *
 * @param {Buffer[]} samples Training data, one Buffer per resource
 * @param {object} options Options
 * @param {number} options.size Maximum dictionary size in bytes
 * @returns {Buffer} Dictionary
 * @throws {Error} If `size` isn't positive
 */
export function buildRawDictionary(samples, { size } = {}) {
    if (!(size > 0)) {
        throw new Error("Dictionary size must be > 0");
    }

    const parts = [];
    let remaining = size;

    for (const s of samples) {
        if (remaining <= 0) {
            break;
        }

        // subarray() clamps to the sample length, so this takes the whole sample when it fits
        const part = s.subarray(0, remaining);

        parts.push(part);
        remaining -= part.length;
    }

    return Buffer.concat(parts);
}

/**
 * Quickly estimates how well a dictionary works: total zstd level-3 size of the samples.
 *
 * Used to compare candidate parameters; the absolute numbers aren't meaningful.
 *
 * @param {Buffer} dictionary Candidate dictionary (may be empty)
 * @param {Buffer[]} samples Samples to compress
 * @returns {number} Total compressed bytes (lower is better)
 */
function quickCost(dictionary, samples) {
    const opts = { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } };

    if (dictionary.length) {
        opts.dictionary = dictionary;
    }

    return samples.reduce((sum, s) => sum + zlib.zstdCompressSync(s, opts).length, 0);
}

/**
 * Builds a dictionary with the given strategy.
 *
 * With `optimize`, several (k, d) combinations are tried for `cover`. Each one
 * is scored by fast zstd compression of a held-out 20% of the samples (or of
 * all samples, if there are fewer than 5).
 *
 * @param {Buffer[]} samples Training data, one Buffer per resource
 * @param {object} options Options
 * @param {"cover"|"raw"} [options.strategy] Strategy
 * @param {number} options.size Maximum dictionary size in bytes
 * @param {number} [options.k] COVER segment size (fixed when given, even with `optimize`)
 * @param {number} [options.d] COVER dmer size (fixed when given, even with `optimize`)
 * @param {boolean} [options.optimize] Search for the best k / d
 * @returns {{dictionary: Buffer, params: CoverParams}} The dictionary, and the COVER parameters
 *   used (empty for `raw`)
 * @throws {Error} For an unknown strategy
 */
export function buildDictionary(samples, { strategy = "cover", size, k, d, optimize = false } = {}) {
    if (strategy === "raw") {
        return { dictionary: buildRawDictionary(samples, { size }), params: {} };
    }

    if (strategy !== "cover") {
        throw new Error(`Unknown strategy "${strategy}"`);
    }

    if (!optimize) {
        const params = { k: k ?? DEFAULT_K, d: d ?? DEFAULT_D };

        return { dictionary: buildCoverDictionary(samples, { size, ...params }), params };
    }

    // Hold out every 5th sample for scoring, so parameters are judged on data the candidate
    // dictionary didn't see. With fewer than 5 samples there's not enough to split.
    const holdout = samples.length >= 5;
    const trainSet = holdout ? samples.filter((_, i) => i % 5 !== 4) : samples;
    const testSet = holdout ? samples.filter((_, i) => i % 5 === 4) : samples;

    // Candidate values (segments can't be bigger than the dictionary itself)
    const ks = k ? [k] : [256, 512, 1024, 2048].filter((v) => v <= size);
    const ds = d ? [d] : [6, 8];

    let best = null;

    // Grid search: build a dictionary for every combination and keep the cheapest
    for (const dd of ds) {
        for (const kk of ks.length ? ks : [Math.min(DEFAULT_K, size)]) {
            const cost = quickCost(buildCoverDictionary(trainSet, { size, k: kk, d: dd }), testSet);

            if (!best || cost < best.cost) {
                best = { k: kk, d: dd, cost };
            }
        }
    }

    // Rebuild with the winning parameters using *all* samples
    const params = { k: best.k, d: best.d };

    return { dictionary: buildCoverDictionary(samples, { size, ...params }), params };
}

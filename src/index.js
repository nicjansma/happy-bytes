/**
 * Library entry point: fetches a site, builds Compression Dictionaries for each resource set, and
 * measures their savings.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotli, zstd, measureBaseline, measureWithDictionary } from "./compress.js";
import { buildDictionary } from "./dictionary.js";
import { collectResources } from "./fetch.js";
import { formatBytes, noop } from "./util.js";

export { buildDictionary, buildCoverDictionary, buildRawDictionary } from "./dictionary.js";
export { collectResources, classifyResource } from "./fetch.js";
export { extractSubresources } from "./extract.js";
export { formatReport } from "./report.js";

/**
 * Running totals of sizes for a group of resources.
 *
 * @typedef {object} Totals
 * @property {number} files Number of resources
 * @property {number} original Uncompressed bytes
 * @property {number} gzip gzip bytes
 * @property {number} br Brotli bytes
 * @property {number} zstd Zstandard bytes
 * @property {number} brDict Brotli + dictionary bytes (with dcb header)
 * @property {number} zstdDict Zstandard + dictionary bytes (with dcz header)
 */

/**
 * Resource details included in the report (no body).
 *
 * @typedef {object} PublicResource
 * @property {string} url Final URL
 * @property {"html"|"js"|"css"} type Resource type
 * @property {number} size Bytes
 * @property {string} sha256 SHA-256 of the body (hex)
 */

// Resource types we handle
export const TYPES = ["html", "js", "css"];

// Which resource types go into each dictionary set
export const SET_TYPES = { html: ["html"], js: ["js"], css: ["css"], all: ["html", "js", "css"] };

// Supported dictionary building strategies (see dictionary.js)
export const STRATEGIES = ["cover", "raw"];

// Use-As-Dictionary match-dest value for each single-type set (Fetch request destinations)
const MATCH_DEST = { html: "document", js: "script", css: "style" };

// Default options for generateDictionaries()
export const DEFAULTS = {
    size: 64 * 1024,
    sets: Object.keys(SET_TYPES),
    strategies: ["cover"],
    optimize: false,
    evalUrls: [],
    subresources: true,
    thirdParty: false,
    concurrency: 6,
    timeout: 30000,
    headers: {},
    userAgent: undefined,
    brotliQuality: 11,
    zstdLevel: 19,
    gzipLevel: 9,
    outDir: null,
    log: noop
};

/**
 * Creates an all-zero {@link Totals} object.
 *
 * @returns {Totals} Empty totals
 */
function emptyTotals() {
    return { files: 0, original: 0, gzip: 0, br: 0, zstd: 0, brDict: 0, zstdDict: 0 };
}

/**
 * Adds one resource's measurements to a running total.
 *
 * @param {Totals} totals Totals to update (modified in place)
 * @param {object} m Measurements for one resource (baseline sizes plus brDict / zstdDict)
 * @returns {void}
 */
function accumulate(totals, m) {
    totals.files++;

    for (const key of ["original", "gzip", "br", "zstd", "brDict", "zstdDict"]) {
        totals[key] += m[key];
    }
}

/**
 * Counts resources and bytes per type.
 *
 * @param {import("./fetch.js").Resource[]} resources Resources to summarize
 * @returns {Record<string, {files: number, bytes: number}>} Counts keyed by type
 */
function summarizeResources(resources) {
    const byType = {};

    for (const r of resources) {
        byType[r.type] ??= { files: 0, bytes: 0 };
        byType[r.type].files++;
        byType[r.type].bytes += r.size;
    }

    return byType;
}

/**
 * Strips a resource down to what belongs in the JSON report (dropping the body).
 *
 * @param {import("./fetch.js").Resource} r Resource
 * @returns {PublicResource} Report-friendly resource details
 */
function publicResource(r) {
    return { url: r.finalUrl, type: r.type, size: r.size, sha256: r.hash };
}

/**
 * Builds a suggested `Use-As-Dictionary` response header value for a dictionary.
 *
 * @param {string} set Dictionary set (html / js / css / all)
 * @param {string} id Dictionary id
 * @returns {string} Header value, e.g. `match="/*", match-dest=("script"), id="js"`
 */
function useAsDictionaryHeader(set, id) {
    const types = SET_TYPES[set];

    // "/*" is a placeholder: the user should narrow it to the paths the dictionary applies to
    const parts = ['match="/*"'];

    // Single-type sets can be restricted to that request destination; "all" applies to everything
    if (types.length === 1) {
        parts.push(`match-dest=("${MATCH_DEST[types[0]]}")`);
    }

    parts.push(`id="${id}"`);

    return parts.join(", ");
}

/**
 * Fetches the site, builds a dictionary for every (set, strategy) pair, and
 * measures how well each one compresses the evaluation resources.
 *
 * @param {object} options Options (see DEFAULTS for the defaults)
 * @param {string[]} options.urls Training URLs (required)
 * @param {string[]} [options.evalUrls] Holdout URLs to measure on (defaults to the training data)
 * @param {string[]} [options.sets] Sets to build: html / js / css / all
 * @param {string[]} [options.strategies] Strategies: cover / raw
 * @param {number} [options.size] Maximum dictionary size in bytes
 * @param {boolean} [options.optimize] Search COVER parameters
 * @param {number} [options.k] COVER segment size
 * @param {number} [options.d] COVER dmer size
 * @param {boolean} [options.subresources] Follow <script> / <link> from HTML pages
 * @param {boolean} [options.thirdParty] Include cross-origin subresources
 * @param {number} [options.concurrency] Maximum parallel requests
 * @param {number} [options.timeout] Request timeout in milliseconds
 * @param {Record<string, string>} [options.headers] Extra request headers
 * @param {string} [options.userAgent] User-Agent header
 * @param {number} [options.brotliQuality] Brotli quality
 * @param {number} [options.zstdLevel] Zstandard level
 * @param {number} [options.gzipLevel] gzip level
 * @param {string|null} [options.outDir] Directory to write dictionaries and report.json to (null = don't write)
 * @param {function(string): void} [options.log] Progress logger
 * @returns {Promise<object>} Report (JSON-serializable)
 * @throws {Error} On invalid options, or when nothing could be fetched
 */
export async function generateDictionaries(options) {
    const opts = { ...DEFAULTS, ...options };
    const { log } = opts;

    //
    // Validate options
    //
    if (!opts.urls?.length) {
        throw new Error("At least one URL is required");
    }

    for (const set of opts.sets) {
        if (!SET_TYPES[set]) {
            throw new Error(`Unknown set "${set}" (expected ${Object.keys(SET_TYPES).join(", ")})`);
        }
    }

    for (const s of opts.strategies) {
        if (!STRATEGIES.includes(s)) {
            throw new Error(`Unknown strategy "${s}" (expected ${STRATEGIES.join(", ")})`);
        }
    }

    const collectOptions = {
        subresources: opts.subresources,
        thirdParty: opts.thirdParty,
        concurrency: opts.concurrency,
        fetchOptions: {
            headers: opts.headers,
            timeout: opts.timeout,
            // Only override the default User-Agent when one was given
            ...(opts.userAgent ? { userAgent: opts.userAgent } : {})
        },
        log
    };

    //
    // Fetch the training resources
    //
    log(`Fetching ${opts.urls.length} training URL(s)...`);
    const training = await collectResources(opts.urls, collectOptions);

    if (!training.resources.length) {
        throw new Error("No resources could be fetched from the training URLs");
    }

    //
    // Pick the evaluation resources: the holdout pages if given, otherwise the training data itself
    //
    let evalResources = training.resources;
    let evalPages = training.pages;
    let evaluation = {
        source: "training",
        pages: training.pages.length,
        resources: training.resources.length,
        excludedIdentical: 0,
        errors: []
    };

    if (opts.evalUrls.length) {
        log(`Fetching ${opts.evalUrls.length} evaluation URL(s)...`);
        const held = await collectResources(opts.evalUrls, collectOptions);

        // Resources byte-identical to a training resource (e.g. a shared bundle)
        // would already be in the browser cache, so they're left out of the evaluation.
        const trainingHashes = new Set(training.resources.map((r) => r.hash));

        evalResources = held.resources.filter((r) => !trainingHashes.has(r.hash));
        evalPages = held.pages;
        evaluation = {
            source: "holdout",
            pages: held.pages.length,
            resources: evalResources.length,
            excludedIdentical: held.resources.length - evalResources.length,
            errors: held.errors
        };

        if (!evalResources.length) {
            throw new Error("No evaluation resources (all failed, or all were identical to training resources)");
        }
    }

    const compressionOptions = {
        gzipLevel: opts.gzipLevel,
        brotliQuality: opts.brotliQuality,
        zstdLevel: opts.zstdLevel
    };

    // The no-dictionary sizes don't depend on the dictionary, so compute them once per resource
    log(`Compressing ${evalResources.length} evaluation resource(s) without a dictionary...`);
    const baselines = new Map(evalResources.map((r) => [r, measureBaseline(r.body, compressionOptions)]));

    if (opts.outDir) {
        await mkdir(opts.outDir, { recursive: true });
    }

    const dictionaries = [];
    const skipped = [];

    //
    // Build and measure one dictionary per (set, strategy)
    //
    for (const set of opts.sets) {
        const types = SET_TYPES[set];

        // Train on this set's resource types, and measure on the same types only
        const samples = training.resources.filter((r) => types.includes(r.type));
        const targets = evalResources.filter((r) => types.includes(r.type));

        for (const strategy of opts.strategies) {
            // Only add the strategy to the id when comparing several (e.g. "js-cover" vs "js-raw")
            const id = opts.strategies.length > 1 ? `${set}-${strategy}` : set;

            if (!samples.length) {
                skipped.push({ id, reason: `no ${types.join("/")} training resources` });
                continue;
            }

            log(`Building "${id}" dictionary from ${samples.length} resource(s)...`);
            const started = Date.now();
            const { dictionary, params } = buildDictionary(samples.map((r) => r.body), {
                strategy,
                size: opts.size,
                k: opts.k,
                d: opts.d,
                optimize: opts.optimize
            });
            const buildMs = Date.now() - started;

            // COVER returns an empty dictionary when nothing is shared
            if (!dictionary.length) {
                skipped.push({ id, reason: "no content repeated across the training resources" });
                continue;
            }

            // Browsers identify dictionaries by their SHA-256 (sent back in Available-Dictionary)
            const digest = createHash("sha256").update(dictionary).digest();
            const entry = {
                id,
                set,
                strategy,
                params,
                buildMs,
                samples: samples.map(publicResource),
                size: dictionary.length,
                sha256: digest.toString("hex"),
                // The dictionary itself is downloaded once, compressed normally
                compressed: {
                    br: brotli(dictionary, { quality: opts.brotliQuality }).length,
                    zstd: zstd(dictionary, { level: opts.zstdLevel }).length
                },
                headers: {
                    "Use-As-Dictionary": useAsDictionaryHeader(set, id),
                    // Structured-field byte sequence: base64 between colons
                    "Available-Dictionary": `:${digest.toString("base64")}:`
                },
                file: null,
                results: { byType: {}, total: emptyTotals(), resources: [] }
            };

            log(`  ${formatBytes(dictionary.length)} in ${buildMs} ms; measuring ${targets.length} resource(s)...`);

            for (const r of targets) {
                // Combine the cached baseline sizes with the with-dictionary sizes
                const m = { ...baselines.get(r), ...measureWithDictionary(r.body, dictionary, compressionOptions) };

                entry.results.byType[r.type] ??= emptyTotals();
                accumulate(entry.results.byType[r.type], m);
                accumulate(entry.results.total, m);
                entry.results.resources.push({ url: r.finalUrl, type: r.type, ...m });
            }

            // Break-even: page views until the bytes saved cover the one-time
            // download of the (brotli-compressed) dictionary.
            const savedPerPage = (entry.results.total.br - entry.results.total.brDict) / Math.max(1, evalPages.length);

            // null = the dictionary never pays for itself (no savings)
            entry.breakEvenViews = savedPerPage > 0 ? Math.ceil(entry.compressed.br / savedPerPage) : null;

            if (opts.outDir) {
                entry.file = path.join(opts.outDir, `${id}.dict`);
                await writeFile(entry.file, dictionary);
            }

            dictionaries.push(entry);
        }
    }

    //
    // Assemble (and optionally save) the report
    //
    const report = {
        generatedAt: new Date().toISOString(),
        settings: {
            size: opts.size,
            sets: opts.sets,
            strategies: opts.strategies,
            optimize: opts.optimize,
            brotliQuality: opts.brotliQuality,
            zstdLevel: opts.zstdLevel,
            gzipLevel: opts.gzipLevel
        },
        training: {
            urls: opts.urls,
            pages: training.pages.length,
            resources: training.resources.map(publicResource),
            byType: summarizeResources(training.resources),
            errors: training.errors,
            skippedThirdParty: training.skippedThirdParty
        },
        evaluation: { ...evaluation, urls: opts.evalUrls, byType: summarizeResources(evalResources) },
        dictionaries,
        skipped
    };

    if (opts.outDir) {
        report.reportFile = path.join(opts.outDir, "report.json");
        await writeFile(report.reportFile, JSON.stringify(report, null, 2));
    }

    return report;
}

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateDictionaries, formatReport, SET_TYPES, STRATEGIES, DEFAULTS } from "../src/index.js";
import { noop, parseSize } from "../src/util.js";

// Usage text for --help

const HELP = `Usage: happy-bytes [options] <url> [url...]

Fetches the given pages (and the same-origin JS/CSS they reference), builds
Compression Dictionaries for each resource set, and reports how much they save.

Input:
  -f, --url-file <file>      Read training URLs from a file (one per line, # comments)
  -e, --eval <url>           Holdout URL to measure savings on (not used for training).
                             Repeatable. Without it, savings are measured on the
                             training data and are optimistic.
      --eval-file <file>     Read holdout URLs from a file
      --no-subresources      Only use the given URLs (don't follow <script>/<link>)
      --third-party          Include cross-origin JS/CSS (dictionaries are
                             origin-scoped, so these usually can't benefit)

Dictionaries:
  -s, --sets <list>          Comma-separated sets to build: ${Object.keys(SET_TYPES).join(",")} (default: all four)
      --strategy <list>      Comma-separated strategies: ${STRATEGIES.join(",")} (default: cover)
                               cover - substrings shared across resources (zstd COVER-style)
                               raw   - plain concatenation of resources (previous-version style)
  -z, --size <size>          Maximum dictionary size, e.g. 64k, 128k, 1m (default: 64k)
      --optimize             Try several segment/dmer sizes and keep the best (slower)
      --k <bytes>            COVER segment size (default: 1024)
      --d <bytes>            COVER dmer size (default: 8)

Compression:
      --brotli-quality <n>   Brotli quality, 0-11 (default: 11)
      --zstd-level <n>       Zstandard level, 1-22 (default: 19)
      --gzip-level <n>       Gzip level for the baseline column, 1-9 (default: 9)

Fetching:
  -H, --header <h>           Extra request header "Name: value" (repeatable)
  -A, --user-agent <ua>      User-Agent to send
      --concurrency <n>      Parallel requests (default: 6)
      --timeout <ms>         Per-request timeout (default: 30000)

Output:
  -o, --out <dir>            Where to write *.dict files and report.json (default: ./dictionaries)
      --json                 Print the JSON report to stdout instead of the text report
  -q, --quiet                No progress output
  -h, --help                 Show this help

Examples:
  happy-bytes https://example.com/
  happy-bytes -f urls.txt -e https://example.com/about --strategy cover,raw --size 128k
`;

/**
 * Reads a list of URLs from a text file.
 *
 * @param {string} file Path to a file with one URL per line; blank lines and `#` comments are ignored
 * @returns {Promise<string[]>} URLs, in file order
 */
async function readUrlFile(file) {
    const text = await readFile(file, "utf8");

    return text
        // Handle both Unix and Windows line endings
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}

/**
 * Splits a comma-separated option value, e.g. `"html, js"` -> `["html", "js"]`.
 *
 * @param {string} value Option value
 * @returns {string[]} Non-empty, trimmed items
 */
function list(value) {
    return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Parses and range-checks an integer option.
 *
 * @param {string} name Option name (for the error message)
 * @param {string|number} value Option value
 * @param {number} min Minimum allowed value (inclusive)
 * @param {number} max Maximum allowed value (inclusive)
 * @returns {number} The parsed integer
 * @throws {Error} If the value isn't an integer within [min, max]
 */
function int(name, value, min, max) {
    const n = Number(value);

    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    }

    return n;
}

/**
 * Validates a URL given on the command line.
 *
 * @param {string} u URL as typed
 * @returns {string} Normalized absolute URL
 * @throws {Error} If it isn't a valid http(s) URL
 */
function validateUrl(u) {
    let url;

    try {
        url = new URL(u);
    } catch {
        throw new Error(`Invalid URL: ${u}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Only http(s) URLs are supported: ${u}`);
    }

    return url.href;
}

/**
 * CLI entry point: parses arguments, runs generateDictionaries() and prints the report.
 *
 * @returns {Promise<void>} Resolves when done (sets `process.exitCode` on usage errors)
 */
async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            "url-file": { type: "string", short: "f", multiple: true },
            eval: { type: "string", short: "e", multiple: true },
            "eval-file": { type: "string", multiple: true },
            "no-subresources": { type: "boolean" },
            "third-party": { type: "boolean" },
            sets: { type: "string", short: "s" },
            strategy: { type: "string" },
            size: { type: "string", short: "z" },
            optimize: { type: "boolean" },
            k: { type: "string" },
            d: { type: "string" },
            "brotli-quality": { type: "string" },
            "zstd-level": { type: "string" },
            "gzip-level": { type: "string" },
            header: { type: "string", short: "H", multiple: true },
            "user-agent": { type: "string", short: "A" },
            concurrency: { type: "string" },
            timeout: { type: "string" },
            out: { type: "string", short: "o" },
            json: { type: "boolean" },
            quiet: { type: "boolean", short: "q" },
            help: { type: "boolean", short: "h" }
        }
    });

    if (values.help) {
        process.stdout.write(HELP);

        return;
    }

    // Training URLs come from the positional arguments plus any --url-file files
    const urls = [...positionals];

    for (const f of values["url-file"] ?? []) {
        urls.push(...(await readUrlFile(f)));
    }

    const evalUrls = [...(values.eval ?? [])];

    for (const f of values["eval-file"] ?? []) {
        evalUrls.push(...(await readUrlFile(f)));
    }

    // Nothing to do: show usage and fail
    if (!urls.length) {
        process.stderr.write(HELP);
        process.exitCode = 1;

        return;
    }

    // Parse each --header "Name: value"
    const headers = {};

    for (const h of values.header ?? []) {
        // Split on the first colon only, since values may contain colons (e.g. URLs)
        const idx = h.indexOf(":");

        // idx 0 would mean an empty header name
        if (idx < 1) {
            throw new Error(`Invalid header "${h}" (expected "Name: value")`);
        }

        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }

    const size = values.size ? parseSize(values.size) : DEFAULTS.size;

    // Map CLI flags to generateDictionaries() options, validating ranges as we go
    const options = {
        // Sets remove duplicate URLs
        urls: [...new Set(urls.map(validateUrl))],
        evalUrls: [...new Set(evalUrls.map(validateUrl))],
        sets: values.sets ? list(values.sets) : DEFAULTS.sets,
        strategies: values.strategy ? list(values.strategy) : DEFAULTS.strategies,
        size: int("size", size, 64, 128 * 1024 * 1024),
        optimize: !!values.optimize,
        k: values.k ? int("k", values.k, 16, 1 << 20) : undefined,
        d: values.d ? int("d", values.d, 4, 16) : undefined,
        brotliQuality: values["brotli-quality"] ?
            int("brotli-quality", values["brotli-quality"], 0, 11) :
            DEFAULTS.brotliQuality,
        zstdLevel: values["zstd-level"] ? int("zstd-level", values["zstd-level"], 1, 22) : DEFAULTS.zstdLevel,
        gzipLevel: values["gzip-level"] ? int("gzip-level", values["gzip-level"], 1, 9) : DEFAULTS.gzipLevel,
        subresources: !values["no-subresources"],
        thirdParty: !!values["third-party"],
        headers,
        userAgent: values["user-agent"],
        concurrency: values.concurrency ? int("concurrency", values.concurrency, 1, 64) : DEFAULTS.concurrency,
        timeout: values.timeout ? int("timeout", values.timeout, 1, 10 * 60 * 1000) : DEFAULTS.timeout,
        outDir: values.out ?? "dictionaries",
        // Progress goes to stderr so stdout stays clean for the report (e.g. --json > report.json)
        log: values.quiet ? noop : (msg) => process.stderr.write(`${msg}\n`)
    };

    const report = await generateDictionaries(options);

    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `\n${formatReport(report)}\n`);
}

// Report errors as a single line rather than a stack trace
main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
});

/**
 * Fetching pages and the JavaScript / CSS they reference.
 */
import { createHash } from "node:crypto";
import { extractSubresources } from "./extract.js";
import { formatBytes, mapLimit, noop } from "./util.js";

/**
 * A fetched HTTP response.
 *
 * @typedef {object} FetchedResponse
 * @property {string} url URL that was requested
 * @property {string} finalUrl URL after redirects
 * @property {number} status HTTP status code
 * @property {string} contentType Content-Type header ("" if missing)
 * @property {Buffer} body Decoded (decompressed) response body
 */

/**
 * A fetched and classified resource.
 *
 * @typedef {object} Resource
 * @property {string} url URL that was requested
 * @property {string} finalUrl URL after redirects (used as the unique key)
 * @property {"html"|"js"|"css"} type Resource type
 * @property {string} contentType Content-Type header
 * @property {number} size Body size in bytes
 * @property {string} hash SHA-256 of the body (hex)
 * @property {string} page Page URL that led to this resource (itself, for pages)
 * @property {Buffer} body Response body
 */

/**
 * Options for a single fetch.
 *
 * @typedef {object} FetchOptions
 * @property {Record<string, string>} [headers] Extra request headers
 * @property {number} [timeout] Timeout in milliseconds
 * @property {string} [userAgent] User-Agent header
 * @property {string} [accept] Accept header
 */

// Chrome-like UA (so sites serve what browsers see), tagged with this tool's name
export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 happy-bytes/0.1";

// Accept header a browser sends for a navigation
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * Classifies a response as html / js / css using its Content-Type, falling back to the URL's file extension.
 *
 * @param {string} [contentType] Content-Type header value
 * @param {string} [url] Response URL
 * @returns {"html"|"js"|"css"|null} Resource type, or null if it's none of those
 */
export function classifyResource(contentType = "", url = "") {
    // Drop parameters such as "; charset=utf-8"
    const ct = contentType.split(";")[0].trim().toLowerCase();

    if (ct === "text/html" || ct === "application/xhtml+xml") {
        return "html";
    }

    // application/javascript, text/javascript, application/x-javascript, text/ecmascript, ...
    if (/(java|ecma)script/.test(ct)) {
        return "js";
    }

    if (ct === "text/css") {
        return "css";
    }

    // Missing or generic Content-Type (e.g. application/octet-stream): fall back to the extension
    let pathname = "";

    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        // Not a valid URL; leave pathname empty
    }

    if (/\.[mc]?js$/.test(pathname)) {
        return "js";
    }

    if (pathname.endsWith(".css")) {
        return "css";
    }

    if (/\.x?html?$/.test(pathname)) {
        return "html";
    }

    return null;
}

/**
 * Fetches one URL, following redirects.
 *
 * @param {string} url URL to fetch
 * @param {FetchOptions} [options] Request options
 * @returns {Promise<FetchedResponse>} The response, with its body fully read
 * @throws {Error} On network errors, timeouts or non-2xx responses
 */
export async function fetchResource(url, {
    headers = {},
    timeout = 30000,
    userAgent = DEFAULT_USER_AGENT,
    accept = "*/*"
} = {}) {
    const requestHeaders = { "user-agent": userAgent, accept };

    // Lower-case user headers so they replace (rather than duplicate) the defaults above
    for (const [k, v] of Object.entries(headers)) {
        requestHeaders[k.toLowerCase()] = v;
    }

    const res = await fetch(url, { headers: requestHeaders, redirect: "follow", signal: AbortSignal.timeout(timeout) });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }

    // fetch() has already undone any Content-Encoding, so this is the original content
    const body = Buffer.from(await res.arrayBuffer());

    return {
        url,
        finalUrl: res.url || url,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body
    };
}

/**
 * Converts a fetched response into a {@link Resource}.
 *
 * @param {FetchedResponse} response Fetched response
 * @param {"html"|"js"|"css"} type Resource type
 * @param {string} page Page URL that led to this resource
 * @returns {Resource} Resource record
 */
function toResource(response, type, page) {
    return {
        url: response.url,
        finalUrl: response.finalUrl,
        type,
        contentType: response.contentType,
        size: response.body.length,
        // Used later to spot identical files (e.g. the same bundle under two URLs)
        hash: createHash("sha256").update(response.body).digest("hex"),
        page,
        body: response.body
    };
}

/**
 * Fetches the given URLs and (optionally) the same-origin JS/CSS they reference.
 *
 * Failures are collected in `errors` instead of being thrown, so one bad URL doesn't stop the run.
 *
 * @param {string[]} urls Page (or direct resource) URLs
 * @param {object} [options] Options
 * @param {boolean} [options.subresources] Also fetch the JS/CSS referenced by HTML pages
 * @param {boolean} [options.thirdParty] Include subresources from other origins
 * @param {number} [options.concurrency] Maximum parallel requests
 * @param {FetchOptions} [options.fetchOptions] Request options
 * @param {function(string): void} [options.log] Progress logger
 * @returns {Promise<{resources: Resource[], pages: string[], errors: {url: string, error: string}[],
 *   skippedThirdParty: string[]}>} Fetched resources (unique by final URL), the input URLs that
 *   succeeded, fetch errors, and the third-party URLs that were skipped
 */
export async function collectResources(urls, {
    subresources = true,
    thirdParty = false,
    concurrency = 6,
    fetchOptions = {},
    log = noop
} = {}) {
    // finalUrl -> Resource
    const resources = new Map();
    const errors = [];
    const pages = [];
    const skippedThirdParty = new Set();

    // Subresources still to fetch: url -> { type, page }
    const queue = new Map();

    /**
     * Records a resource unless one with the same final URL already exists.
     *
     * @param {Resource} resource Resource to add
     * @returns {void}
     */
    const add = (resource) => {
        if (!resources.has(resource.finalUrl)) {
            resources.set(resource.finalUrl, resource);
        }
    };

    //
    // Step 1: fetch the input URLs (as navigations)
    //
    const fetched = await mapLimit(urls, concurrency, async(url) => {
        try {
            const response = await fetchResource(url, { ...fetchOptions, accept: HTML_ACCEPT });

            log(`  fetched ${url} (${formatBytes(response.body.length)})`);

            return response;
        } catch (err) {
            errors.push({ url, error: err.message });
            log(`  FAILED  ${url}: ${err.message}`);

            return null;
        }
    });

    //
    // Step 2: classify them, and queue up the subresources of HTML pages
    //
    for (const response of fetched) {
        // Failed fetch (already recorded in errors)
        if (!response) {
            continue;
        }

        const type = classifyResource(response.contentType, response.finalUrl);

        if (!type) {
            errors.push({ url: response.url, error: `unsupported content-type "${response.contentType}"` });
            continue;
        }

        pages.push(response.url);
        add(toResource(response, type, response.url));

        if (type === "html" && subresources) {
            // Use the post-redirect origin, since that's where the dictionary would be served from
            const origin = new URL(response.finalUrl).origin;

            for (const sub of extractSubresources(response.body.toString("utf8"), response.finalUrl)) {
                // Dictionaries are origin-scoped, so cross-origin files can't use them
                if (!thirdParty && new URL(sub.url).origin !== origin) {
                    skippedThirdParty.add(sub.url);
                    continue;
                }

                // Pages often share bundles; only fetch each URL once
                if (!resources.has(sub.url) && !queue.has(sub.url)) {
                    queue.set(sub.url, { type: sub.type, page: response.url });
                }
            }
        }
    }

    //
    // Step 3: fetch the queued subresources
    //
    const subFetched = await mapLimit([...queue], concurrency, async([url, { type: hinted, page }]) => {
        try {
            const response = await fetchResource(url, fetchOptions);

            // Trust the server's Content-Type when it has one; otherwise use how the page referenced it
            const type = classifyResource(response.contentType, response.finalUrl) ?? hinted;

            // e.g. a 200 HTML error page served instead of the script
            if (type !== hinted) {
                throw new Error(`expected ${hinted} but got content-type "${response.contentType}"`);
            }

            log(`  fetched ${url} (${formatBytes(response.body.length)})`);

            return toResource(response, type, page);
        } catch (err) {
            errors.push({ url, error: err.message });
            log(`  FAILED  ${url}: ${err.message}`);

            return null;
        }
    });

    for (const resource of subFetched) {
        if (resource) {
            add(resource);
        }
    }

    return { resources: [...resources.values()], pages, errors, skippedThirdParty: [...skippedThirdParty] };
}

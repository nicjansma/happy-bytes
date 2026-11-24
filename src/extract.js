/**
 * Lightweight extraction of script / stylesheet URLs from an HTML document.
 *
 * Intentionally regex based (no DOM dependency). Handles the common cases:
 * <script src>, <link rel=stylesheet>, <link rel=modulepreload> and
 * <link rel=preload as=script|style>, honoring <base href>. Content inside
 * comments, <noscript>, <template>, <style> and inline <script> bodies is ignored.
 */

/**
 * A subresource referenced by an HTML page.
 *
 * @typedef {object} Subresource
 * @property {string} url Absolute URL (fragment removed)
 * @property {"js"|"css"} type Resource type
 */

// HTML comments, e.g. <!-- <script src="old.js"></script> -->
const COMMENT_RE = /<!--[\s\S]*?-->/g;

// Elements whose contents are raw text (or never loaded). Group 1 is the opening tag, which is kept
// so that <script src> still matches; the body is dropped so markup inside JS strings isn't parsed.
const RAW_TEXT_RE = /(<(script|style|template|noscript)\b(?:[^>"']|"[^"]*"|'[^']*')*>)[\s\S]*?<\/\2\s*>/gi;

// Opening <script>, <link> and <base> tags. Group 2 is the attribute source; quoted values may contain ">".
const TAG_RE = /<(script|link|base)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

// One attribute: name, then an optional double-quoted (2), single-quoted (3) or unquoted (4) value
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// <script type> values that browsers execute as JavaScript ("" = no type attribute)
const JS_SCRIPT_TYPES = new Set([
    "",
    "module",
    "text/javascript",
    "application/javascript",
    "text/ecmascript",
    "application/ecmascript",
    "application/x-javascript",
    "text/jscript"
]);

// <link rel=preload as=...> values that map to a resource type we care about
const PRELOAD_AS_TYPES = { script: "js", style: "css" };

// The only named entities likely to show up in URL attributes
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decodes numeric (`&#38;`, `&#x26;`) and common named (`&amp;` etc.) HTML entities.
 *
 * @param {string} str Attribute value as written in the HTML
 * @returns {string} Decoded value
 */
export function decodeEntities(str) {
    return str.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
        const e = entity.toLowerCase();

        // Hexadecimal character reference
        if (e.startsWith("#x")) {
            return String.fromCodePoint(parseInt(e.slice(2), 16));
        }

        // Decimal character reference
        if (e.startsWith("#")) {
            return String.fromCodePoint(parseInt(e.slice(1), 10));
        }

        return NAMED_ENTITIES[e] ?? match;
    });
}

/**
 * Parses the attribute portion of a tag into a name -> value map.
 *
 * Names are lower-cased. Boolean attributes (e.g. `async`) get an empty-string value.
 * As in browsers, the first occurrence of a duplicated attribute wins.
 *
 * @param {string} source Text between the tag name and the closing `>`
 * @returns {Record<string, string>} Attribute values, entity-decoded
 */
export function parseAttributes(source) {
    const attrs = {};

    for (const m of source.matchAll(ATTR_RE)) {
        const name = m[1].toLowerCase();

        if (!(name in attrs)) {
            // Whichever quoting style matched; no value at all means a boolean attribute
            attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
        }
    }

    return attrs;
}

/**
 * Resolves a (possibly relative) URL against a base URL.
 *
 * @param {string} href URL as written in the document
 * @param {string} base Base URL to resolve against
 * @returns {string|null} Absolute http(s) URL without its fragment, or null if invalid / not http(s)
 */
function resolveUrl(href, base) {
    try {
        const url = new URL(href.trim(), base);

        // Skip data:, javascript:, blob: and other schemes we can't fetch
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }

        // Fragments are never sent to the server, so they'd only create duplicates
        url.hash = "";

        return url.href;
    } catch {
        return null;
    }
}

/**
 * Finds the JavaScript and CSS files an HTML page loads.
 *
 * @param {string} html HTML source of the page
 * @param {string} pageUrl URL the page was fetched from (used to resolve relative URLs)
 * @returns {Subresource[]} Unique subresources, in document order
 */
export function extractSubresources(html, pageUrl) {
    // Remove comments and raw-text element bodies so we only see real markup
    const cleaned = html.replace(COMMENT_RE, "").replace(RAW_TEXT_RE, "$1");

    let base = pageUrl;
    let baseSeen = false;

    // url -> type; a Map de-duplicates while keeping insertion (document) order
    const found = new Map();

    for (const m of cleaned.matchAll(TAG_RE)) {
        const tag = m[1].toLowerCase();
        const attrs = parseAttributes(m[2]);

        if (tag === "base") {
            // Only the first <base href> counts (per the HTML spec)
            if (!baseSeen && attrs.href) {
                base = resolveUrl(attrs.href, pageUrl) ?? pageUrl;
                baseSeen = true;
            }

            continue;
        }

        let type = null;
        let href;

        if (tag === "script") {
            href = attrs.src;

            // Skip non-JS script blocks such as type="application/ld+json" or "text/template"
            if (JS_SCRIPT_TYPES.has((attrs.type ?? "").trim().toLowerCase())) {
                type = "js";
            }
        } else {
            href = attrs.href;

            // rel is a space-separated token list, e.g. "preload stylesheet"
            const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
            const as = (attrs.as ?? "").trim().toLowerCase();

            if (rel.includes("stylesheet") && !rel.includes("alternate")) {
                // Alternate stylesheets aren't loaded by default, so they're skipped
                type = "css";
            } else if (rel.includes("modulepreload")) {
                type = "js";
            } else if (rel.includes("preload")) {
                // Preloads of fonts, images etc. are ignored
                type = PRELOAD_AS_TYPES[as] ?? null;
            }
        }

        if (!type || !href) {
            continue;
        }

        const url = resolveUrl(href, base);

        if (url && !found.has(url)) {
            found.set(url, type);
        }
    }

    return [...found].map(([url, type]) => ({ url, type }));
}

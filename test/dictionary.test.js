import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildCoverDictionary, buildRawDictionary, buildDictionary } from "../src/dictionary.js";
import { brotli, zstd } from "../src/compress.js";

/**
 * Creates a seeded pseudo-random number generator, so test data is the same on every run.
 *
 * @param {number} seed Initial seed
 * @returns {function(): number} Generator returning numbers in [0, 1)
 */
function rng(seed) {
    return () => {
        // Linear congruential generator (glibc constants), kept to 32 bits
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

        return seed / 2 ** 32;
    };
}

const WORDS = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
    "incididunt ut labore et dolore magna aliqua").split(" ");

/**
 * Generates filler text that's unique per page (random words with random numbers attached).
 *
 * @param {function(): number} rand Random number generator from rng()
 * @param {number} words Number of words
 * @returns {string} Space-separated words
 */
function randomText(rand, words) {
    /**
     * Picks one random word with a random numeric suffix.
     *
     * @returns {string} Word, e.g. "lorem123"
     */
    const word = () => WORDS[Math.floor(rand() * WORDS.length)] + Math.floor(rand() * 1000);

    return Array.from({ length: words }, word).join(" ");
}

/**
 * Builds HTML pages that share a header and footer but have unique main content,
 * like pages of a real site.
 *
 * @param {number} count Number of pages
 * @returns {Buffer[]} Page contents
 */
function makePages(count) {
    const rand = rng(42);
    const header = "<header class=\"site-header\"><nav><a href=\"/\">Home</a>" +
        "<a href=\"/products\">Products</a><a href=\"/about-us\">About us</a></nav></header>";
    const footer = "<footer class=\"site-footer\"><p>Copyright Example Corp. All rights reserved.</p>" +
        "<ul class=\"social\"><li>Mastodon</li><li>RSS</li></ul></footer>";

    return Array.from({ length: count }, (_, i) =>
        Buffer.from(`<!doctype html><html><head><title>Page ${i}</title></head><body>${header}` +
            `<main>${randomText(rand, 300)}</main>${footer}</body></html>`)
    );
}

test("cover dictionary contains content shared across samples", () => {
    const pages = makePages(8);
    const dict = buildCoverDictionary(pages, { size: 4096, k: 256, d: 8 });

    assert.ok(dict.length > 0 && dict.length <= 4096);
    const text = dict.toString();

    assert.ok(text.includes("Copyright Example Corp"), "footer boilerplate should be in the dictionary");
    assert.ok(text.includes("About us"), "header boilerplate should be in the dictionary");
});

test("cover dictionary improves compression of an unseen page", () => {
    const pages = makePages(10);
    const unseen = pages.pop();
    const dict = buildCoverDictionary(pages, { size: 8192 });

    assert.ok(brotli(unseen, { dictionary: dict }).length < brotli(unseen).length);
    assert.ok(zstd(unseen, { dictionary: dict }).length < zstd(unseen).length);
});

test("dictionaries round-trip with brotli and zstd", () => {
    const pages = makePages(4);
    const dict = buildCoverDictionary(pages, { size: 4096 });
    const data = pages[0];

    assert.deepEqual(zlib.brotliDecompressSync(brotli(data, { dictionary: dict }), { dictionary: dict }), data);
    assert.deepEqual(zlib.zstdDecompressSync(zstd(data, { dictionary: dict }), { dictionary: dict }), data);
});

test("cover returns empty dictionary when nothing repeats", () => {
    const rand = rng(7);
    const unique = [Buffer.from(Array.from({ length: 2000 }, () => Math.floor(rand() * 256)))];

    assert.equal(buildCoverDictionary(unique, { size: 1024 }).length, 0);
});

test("raw dictionary concatenates up to the size limit", () => {
    const dict = buildRawDictionary([Buffer.from("aaaa"), Buffer.from("bbbb"), Buffer.from("cccc")], { size: 6 });

    assert.equal(dict.toString(), "aaaabb");
});

test("buildDictionary with optimize picks parameters", () => {
    const { dictionary, params } = buildDictionary(makePages(10), { strategy: "cover", size: 4096, optimize: true });

    assert.ok(dictionary.length > 0);
    assert.ok([6, 8].includes(params.d));
    assert.ok([256, 512, 1024, 2048].includes(params.k));
});

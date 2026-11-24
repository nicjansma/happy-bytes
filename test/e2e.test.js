import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateDictionaries, formatReport } from "../src/index.js";

// Shared "library" code included in every JS bundle, so the bundles have content in common
const lib = Array.from({ length: 200 },
    (_, i) => `function helper${i}(a, b) { return a.map((x) => x * ${i}).filter(Boolean).concat(b); }`).join("\n");

/**
 * One paragraph of page content.
 *
 * @param {number} n Page number
 * @returns {string} Paragraph HTML
 */
const paragraph = (n) => `<p>Paragraph ${n} with some shared prose about compression dictionaries.</p>`;

/**
 * A test page: shared layout, a per-page stylesheet and bundle, one third-party script, and
 * content whose length varies by page.
 *
 * @param {number} n Page number
 * @returns {string} Page HTML
 */
const page = (n) => `<!doctype html><html><head><title>Page ${n}</title>
<link rel="stylesheet" href="/css/site.css?v=${n}">
<script src="/js/app-${n}.js"></script>
<script src="https://third-party.invalid/analytics.js"></script>
</head><body><header><nav><a href="/">Home</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav></header>
<main><h1>Article number ${n}</h1>${paragraph(n).repeat(n + 2)}</main>
<footer>Copyright Example. Built with love and compression.</footer></body></html>`;

let server;
let base;
let outDir;

// Start a local fake site on a random port:
//   /page/<n>        HTML pages
//   /js/app-<n>.js   per-page bundles (all containing `lib`)
//   /css/site.css    stylesheet (varies slightly with ?v=)
//   anything else    404
before(async() => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        const pageMatch = /^\/page\/(\d+)$/.exec(url.pathname);
        const jsMatch = /^\/js\/app-(\d+)\.js$/.exec(url.pathname);

        if (pageMatch) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(page(Number(pageMatch[1])));
        } else if (jsMatch) {
            res.writeHead(200, { "content-type": "application/javascript" });
            res.end(`${lib}\nconsole.log("bundle ${jsMatch[1]}");`);
        } else if (url.pathname === "/css/site.css") {
            res.writeHead(200, { "content-type": "text/css" });
            res.end(`body{margin:0;font-family:system-ui}.v${url.searchParams.get("v")}{color:red}\n`.repeat(20));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    outDir = await mkdtemp(path.join(tmpdir(), "happy-bytes-"));
});

after(async() => {
    server.close();
    await rm(outDir, { recursive: true, force: true });
});

test("generates dictionaries for every set and reports sizes", async() => {
    const report = await generateDictionaries({
        urls: [1, 2, 3, 4].map((n) => `${base}/page/${n}`),
        evalUrls: [`${base}/page/5`, `${base}/page/missing`],
        size: 8 * 1024,
        strategies: ["cover", "raw"],
        outDir
    });

    assert.equal(report.training.pages, 4);
    assert.deepEqual(Object.keys(report.training.byType).sort(), ["css", "html", "js"]);
    assert.equal(report.training.skippedThirdParty.length, 1);
    assert.equal(report.evaluation.source, "holdout");
    assert.equal(report.evaluation.errors.length, 1);

    const ids = report.dictionaries.map((d) => d.id).sort();

    assert.deepEqual(ids, [
        "all-cover", "all-raw", "css-cover", "css-raw", "html-cover", "html-raw", "js-cover", "js-raw"
    ]);

    for (const d of report.dictionaries) {
        const onDisk = await readFile(d.file);

        assert.equal(onDisk.length, d.size);
        assert.ok(d.size <= 8 * 1024);
        assert.match(d.headers["Available-Dictionary"], /^:[A-Za-z0-9+/]+=*:$/);
    }

    const allCover = report.dictionaries.find((d) => d.id === "all-cover");

    assert.deepEqual(Object.keys(allCover.results.byType).sort(), ["css", "html", "js"]);
    assert.ok(allCover.results.total.brDict < allCover.results.total.br, "dictionary should beat plain brotli");
    assert.ok(!allCover.headers["Use-As-Dictionary"].includes("match-dest"));
    const jsCover = report.dictionaries.find((d) => d.id === "js-cover");

    assert.ok(jsCover.headers["Use-As-Dictionary"].includes("match-dest=(\"script\")"));

    const text = formatReport(report);

    assert.match(text, /Compression Dictionary Report/);
    assert.match(text, /all-cover/);

    const json = JSON.parse(await readFile(path.join(outDir, "report.json"), "utf8"));

    assert.equal(json.dictionaries.length, 8);
});

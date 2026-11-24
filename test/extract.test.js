import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSubresources, parseAttributes } from "../src/extract.js";
import { classifyResource } from "../src/fetch.js";

test("parseAttributes handles quoting styles and entities", () => {
    assert.deepEqual(parseAttributes(" src=\"/a.js?x=1&amp;y=2\" async type='module' data-x=y"), {
        src: "/a.js?x=1&y=2",
        async: "",
        type: "module",
        "data-x": "y"
    });
});

test("extractSubresources finds scripts, stylesheets and preloads", () => {
    const html = `<!doctype html><html><head>
    <base href="/static/">
    <link rel="stylesheet" href="main.css">
    <link rel="alternate stylesheet" href="alt.css">
    <link rel="preload" as="script" href="pre.js">
    <link rel="preload" as="font" href="font.woff2">
    <link rel="modulepreload" href="/mod.js#hash">
    <link rel=icon href=favicon.ico>
    <script src="app.js"></script>
    <script type="application/ld+json" src="data.json"></script>
    <script>document.write('<script src="inline.js"><\\/script><link rel="stylesheet" href="inline.css">')</script>
    <!-- <script src="commented.js"></script> -->
    <noscript><link rel="stylesheet" href="noscript.css"></noscript>
    <script src="https://cdn.example.net/lib.js"></script>
    <script src="app.js"></script>
  </head></html>`;

    assert.deepEqual(extractSubresources(html, "https://site.test/page/index.html"), [
        { url: "https://site.test/static/main.css", type: "css" },
        { url: "https://site.test/static/pre.js", type: "js" },
        { url: "https://site.test/mod.js", type: "js" },
        { url: "https://site.test/static/app.js", type: "js" },
        { url: "https://cdn.example.net/lib.js", type: "js" }
    ]);
});

test("classifyResource uses content-type then extension", () => {
    assert.equal(classifyResource("text/html; charset=utf-8", "https://a.test/"), "html");
    assert.equal(classifyResource("application/javascript", "https://a.test/x"), "js");
    assert.equal(classifyResource("text/javascript", "https://a.test/x"), "js");
    assert.equal(classifyResource("text/css", "https://a.test/x"), "css");
    assert.equal(classifyResource("application/octet-stream", "https://a.test/x.mjs"), "js");
    assert.equal(classifyResource("", "https://a.test/x.css"), "css");
    assert.equal(classifyResource("image/png", "https://a.test/x.png"), null);
});

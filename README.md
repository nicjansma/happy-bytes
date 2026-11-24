# happy-bytes

Generate [Compression Dictionaries](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Compression_dictionary_transport)
(Compression Dictionary Transport, RFC 9842) from a live website, and see how much they would save.

Give it one or more page URLs. It fetches the pages plus the same-origin JavaScript and CSS they reference, then
builds a dictionary for each resource set:

| Set    | Built from          | `match-dest`   |
| ------ | ------------------- | -------------- |
| `html` | HTML documents      | `("document")` |
| `js`   | JavaScript          | `("script")`   |
| `css`  | Stylesheets         | `("style")`    |
| `all`  | Everything combined | (none)         |

For each dictionary it reports:

- the dictionary's raw, brotli and zstd sizes (the one-time download cost);
- per-type transfer sizes for gzip, brotli, zstd, **brotli + dictionary (`dcb`)** and **zstd + dictionary (`dcz`)**,
  including the 36/40-byte dcb/dcz header overhead;
- the number of page views before the savings pay back the dictionary download;
- the `Use-As-Dictionary` header to serve it with and the `Available-Dictionary` value browsers will send.

It has no dependencies. It needs Node.js 22.15+ for built-in zstd.

## Usage

```sh
# A single page
node bin/happy-bytes.js https://example.com/

# Several pages, holding out other pages to measure savings honestly
node bin/happy-bytes.js -f urls.txt -e https://example.com/blog/post-9 -e https://example.com/about

# Compare strategies and sizes, only for HTML and JS
node bin/happy-bytes.js -f urls.txt --sets html,js --strategy cover,raw --size 128k
```

Run `node bin/happy-bytes.js --help` for all options. Main ones:

| Option                             | Description                                                                |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `-f, --url-file`                   | File with one URL per line (`#` comments allowed)                          |
| `-e, --eval`, `--eval-file`        | Holdout URLs to measure savings on (not used for training)                 |
| `-s, --sets`                       | `html,js,css,all` (default: all four)                                      |
| `--strategy`                       | `cover` (default) and/or `raw`                                             |
| `-z, --size`                       | Maximum dictionary size (default `64k`)                                    |
| `--optimize`                       | Search COVER parameters (segment size k, dmer size d) for the best result  |
| `--brotli-quality`, `--zstd-level` | Compression settings (defaults 11 / 19, typical for static precompression) |
| `--third-party`                    | Also include cross-origin JS/CSS                                           |
| `--no-subresources`                | Only use the URLs given (they can point straight at JS/CSS files)          |
| `-H, --header`, `-A, --user-agent` | Request customization (e.g. cookies for logged-in pages)                   |
| `-o, --out`                        | Output directory (default `./dictionaries`)                                |
| `--json`                           | Print the JSON report instead of the text report                           |

The output directory gets one `<set>.dict` file per dictionary (`<set>-<strategy>.dict` when several strategies are
used) and a `report.json` with full per-resource details.

### Example output

```
>node bin\happy-bytes.js https://nicj.net
Fetching 1 training URL(s)...
  fetched https://nicj.net/ (217.5 KB)
  fetched https://nicj.net/wp-content/plugins/code-prettify/prettify/prettify.css?x91904 (771 B)
  fetched https://nicj.net/wp-content/cache/minify/34905.css?x91904 (490 B)
  fetched https://nicj.net/wp-content/cache/minify/be247.js?x91904 (27.4 KB)
  fetched https://nicj.net/wp-content/cache/minify/c084a.css?x91904 (41.8 KB)
  fetched https://nicj.net/wp-content/cache/minify/1f540.js?x91904 (17.9 KB)
  fetched https://nicj.net/wp-content/cache/minify/0301f.css?x91904 (101.5 KB)
  fetched https://nicj.net/wp-content/cache/minify/818c0.js?x91904 (98.8 KB)
  fetched https://nicj.net/wp-content/cache/minify/2a6b9.js?x91904 (913 B)
  fetched https://nicj.net/wp-content/cache/minify/d6da9.js?x91904 (28.5 KB)
  fetched https://nicj.net/wp-content/cache/minify/e6deb.js?x91904 (29.2 KB)
Compressing 11 evaluation resource(s) without a dictionary...
Building "html" dictionary from 1 resource(s)...
  64.0 KB in 29 ms; measuring 1 resource(s)...
Building "js" dictionary from 6 resource(s)...
  64.0 KB in 23 ms; measuring 6 resource(s)...
Building "css" dictionary from 4 resource(s)...
  64.0 KB in 18 ms; measuring 4 resource(s)...
Building "all" dictionary from 11 resource(s)...
  64.0 KB in 100 ms; measuring 11 resource(s)...

Compression Dictionary Report
=============================
Training:   1 URL(s) -> 11 resource(s): html: 1 (217.5 KB), js: 6 (202.5 KB), css: 4 (144.5 KB)
Evaluation: on the training resources themselves (optimistic - use --eval for holdout pages)
Settings:   max dictionary size 64.0 KB, brotli q11, zstd 19, gzip 9
            3 third-party resource(s) skipped (use --third-party to include)

Dictionaries
  Dictionary  Samples     Size  Size (br)  Size (zstd)  Params      File
  ----------  -------  -------  ---------  -----------  ----------  ----------------------
  html              1  64.0 KB    17.9 KB      20.3 KB  k=1024 d=8  dictionaries\html.dict
  js                6  64.0 KB    24.2 KB      25.8 KB  k=1024 d=8  dictionaries\js.dict
  css               4  64.0 KB    26.1 KB      27.4 KB  k=1024 d=8  dictionaries\css.dict
  all              11  64.0 KB    25.2 KB      28.4 KB  k=1024 d=8  dictionaries\all.dict

Compressed transfer sizes by type (dictionary sizes include dcb/dcz header overhead)
  Dictionary  Type   Files  Original      gzip        br   br+dict   vs br      zstd  zstd+dict  vs zstd
  ----------  -----  -----  --------  --------  --------  --------  ------  --------  ---------  -------
  html        html       1  217.5 KB   56.9 KB   46.3 KB   30.0 KB  -35.1%   50.2 KB    31.7 KB   -36.8%
  js          js         6  202.5 KB   69.0 KB   61.7 KB   38.2 KB  -38.0%   65.8 KB    39.1 KB   -40.6%
  css         css        4  144.5 KB   52.5 KB   47.1 KB   22.1 KB  -53.1%   49.6 KB    22.6 KB   -54.4%
  all         html       1  217.5 KB   56.9 KB   46.3 KB   38.6 KB  -16.4%   50.2 KB    40.8 KB   -18.8%
  all         js         6  202.5 KB   69.0 KB   61.7 KB   52.9 KB  -14.1%   65.8 KB    54.5 KB   -17.2%
  all         css        4  144.5 KB   52.5 KB   47.1 KB   39.7 KB  -15.8%   49.6 KB    40.6 KB   -18.0%
  all         total     11  564.5 KB  178.4 KB  155.0 KB  131.3 KB  -15.3%  165.6 KB   135.9 KB   -17.9%

Summary (sorted by brotli savings)
  Dictionary  Dict (br)         br saved       zstd saved  Break-even views
  ----------  ---------  ---------------  ---------------  ----------------
  css           26.1 KB  25.0 KB (53.1%)  27.0 KB (54.4%)                 2
  all           25.2 KB  23.7 KB (15.3%)  29.7 KB (17.9%)                 2
  js            24.2 KB  23.5 KB (38.0%)  26.7 KB (40.6%)                 2
  html          17.9 KB  16.2 KB (35.1%)  18.5 KB (36.8%)                 2
  Break-even = page views before the savings pay for downloading the brotli-compressed dictionary.

Serving headers (adjust match= to the URL pattern(s) the dictionary should apply to)
  html:
    Use-As-Dictionary: match="/*", match-dest=("document"), id="html"
    (clients will send) Available-Dictionary: :QvQl0w4rYYeQXiMSCPV8h1kJD1dPX1n65FiM9qhs+Sc=:
  js:
    Use-As-Dictionary: match="/*", match-dest=("script"), id="js"
    (clients will send) Available-Dictionary: :einIV+QBkRbZFQ+IFFU5b0C6tAWP72GbskNlasvIKkY=:
  css:
    Use-As-Dictionary: match="/*", match-dest=("style"), id="css"
    (clients will send) Available-Dictionary: :3GpmEah3kC3Md84jL0J5ZpuLx8WTWi/jrkN7wus4VHM=:
  all:
    Use-As-Dictionary: match="/*", id="all"
    (clients will send) Available-Dictionary: :ryX8YuXMxDdJlJQvH/l/Vpi993eUpJ0ZxcFIyYDg19M=:

Full report: dictionaries\report.json
```

### Library

```js
import { generateDictionaries, formatReport } from 'happy-bytes';

const report = await generateDictionaries({
  urls: ['https://example.com/', 'https://example.com/products'],
  evalUrls: ['https://example.com/about'],
  sets: ['html', 'all'],
  size: 64 * 1024,
  outDir: 'dictionaries',
});
console.log(formatReport(report));
```

## Strategies

- **`cover`** (default) is a JavaScript port of the idea behind zstd's COVER/FASTCOVER trainers. It picks the
  substrings that appear across the most *different* resources, such as shared page templates, framework code and
  CSS utility classes, and puts the most valuable ones at the end of the dictionary, where match distances are
  shortest. This is the right choice when the dictionary should help pages it hasn't seen.
- **`raw`** concatenates the resources up to the size limit. It's the "previous version as dictionary" approach.
  It works best when a set is a single resource (for example one JS bundle) and you will deploy new versions of it.

Both produce raw-content dictionaries, which is what browsers expect for `dcb` and `dcz`.

## Reading the results

- **Use holdout pages (`-e`).** Without them, savings are measured on the same resources the dictionary was built
  from, which overstates them (with `raw`, dramatically). With holdout pages, resources byte-identical to a training
  resource (such as a shared bundle) are excluded, since the browser would already have them cached.
- Dictionaries only apply to same-origin responses whose URL matches `match`. Third-party resources are skipped by
  default for that reason.
- The `match="/*"` in the suggested header is a placeholder. Narrow it to the paths the dictionary should cover.
- Break-even is estimated as `dictionary (br) / (bytes saved / number of evaluated pages)`.

## Tests and linting

```sh
npm test
npm run lint        # or: npm run lint:fix
```

## AI Disclosure

This project is AI generated.

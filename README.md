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

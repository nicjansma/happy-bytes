/**
 * Plain-text formatting of the report returned by generateDictionaries().
 */
import { formatBytes, formatPercent } from "./util.js";

// Order in which resource types are listed
const TYPE_ORDER = ["html", "js", "css"];

/**
 * Renders rows as a fixed-width text table with a header and separator line, indented two spaces.
 *
 * @param {string[]} headers Column headers
 * @param {Array<Array<string|number>>} rows Table rows
 * @param {Array<"l"|"r">} align Alignment per column (left / right)
 * @returns {string} Table text
 */
function table(headers, rows, align) {
    // Each column is as wide as its widest cell (header included)
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));

    /**
     * Pads and joins one row's cells.
     *
     * @param {Array<string|number>} cells Row cells
     * @returns {string} Formatted line
     */
    const fmt = (cells) =>
        cells
            .map((c, i) => (align[i] === "r" ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i])))
            .join("  ")
            .trimEnd();

    const lines = [fmt(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)];

    return lines.map((l) => `  ${l}`).join("\n");
}

/**
 * Formats the relative change from `without` to `withDict`, e.g. `-25.3%` (smaller is better).
 *
 * @param {number} withDict Size with the dictionary
 * @param {number} without Size without the dictionary
 * @returns {string} Signed percentage
 */
function delta(withDict, without) {
    const diff = withDict - without;

    // formatPercent() already includes the "-" for savings; add "+" for regressions
    return `${diff > 0 ? "+" : ""}${formatPercent(diff, without)}`;
}

/**
 * Summarizes per-type counts, e.g. `html: 3 (120.0 KB), js: 5 (1.20 MB)`.
 *
 * @param {Record<string, {files: number, bytes: number}>} byType Counts keyed by type
 * @returns {string} Summary text
 */
function typeSummary(byType) {
    return TYPE_ORDER.filter((t) => byType[t])
        .map((t) => `${t}: ${byType[t].files} (${formatBytes(byType[t].bytes)})`)
        .join(", ");
}

/**
 * Formats a report returned by generateDictionaries() as plain text.
 *
 * @param {object} report Report from generateDictionaries()
 * @returns {string} Multi-line text report
 */
export function formatReport(report) {
    const out = [];
    const s = report.settings;
    const { training, evaluation } = report;

    //
    // Header: inputs and settings
    //
    out.push("Compression Dictionary Report");
    out.push("=============================");

    out.push(`Training:   ${training.pages} URL(s) -> ${training.resources.length} resource(s): ` +
        typeSummary(training.byType));

    if (evaluation.source === "holdout") {
        out.push(`Evaluation: ${evaluation.pages} holdout URL(s) -> ${evaluation.resources} resource(s): ` +
            typeSummary(evaluation.byType));

        if (evaluation.excludedIdentical) {
            out.push(`            (${evaluation.excludedIdentical} resource(s) identical to training ` +
                "resources excluded)");
        }
    } else {
        // Warn that measuring on the training data overstates the savings
        out.push("Evaluation: on the training resources themselves (optimistic - use --eval for holdout pages)");
    }

    out.push(`Settings:   max dictionary size ${formatBytes(s.size)}, ` +
        `brotli q${s.brotliQuality}, zstd ${s.zstdLevel}, gzip ${s.gzipLevel}`);

    if (training.skippedThirdParty.length) {
        out.push(`            ${training.skippedThirdParty.length} third-party resource(s) skipped ` +
            "(use --third-party to include)");
    }

    const errors = [...training.errors, ...(evaluation.errors ?? [])];

    if (errors.length) {
        out.push("", "Fetch errors:");

        for (const e of errors) {
            out.push(`  ${e.url}: ${e.error}`);
        }
    }

    const dicts = report.dictionaries;

    if (!dicts.length) {
        out.push("", "No dictionaries were generated.");
    } else {
        //
        // Dictionaries and their own (download) sizes
        //
        out.push("", "Dictionaries");
        out.push(
            table(
                ["Dictionary", "Samples", "Size", "Size (br)", "Size (zstd)", "Params", "File"],
                dicts.map((d) => [
                    d.id,
                    d.samples.length,
                    formatBytes(d.size),
                    formatBytes(d.compressed.br),
                    formatBytes(d.compressed.zstd),
                    // e.g. "k=1024 d=8" (raw dictionaries have no parameters)
                    Object.entries(d.params).map(([k, v]) => `${k}=${v}`).join(" ") || "-",
                    d.file ?? "-"
                ]),
                ["l", "r", "r", "r", "r", "l", "l"]
            )
        );

        //
        // Per-type transfer sizes for every dictionary
        //
        out.push("", "Compressed transfer sizes by type (dictionary sizes include dcb/dcz header overhead)");
        const rows = [];

        for (const d of dicts) {
            const groups = TYPE_ORDER.filter((t) => d.results.byType[t]).map((t) => [t, d.results.byType[t]]);

            // Multi-type dictionaries ("all") also get a total row
            if (groups.length > 1) {
                groups.push(["total", d.results.total]);
            }

            for (const [type, t] of groups) {
                rows.push([
                    d.id,
                    type,
                    t.files,
                    formatBytes(t.original),
                    formatBytes(t.gzip),
                    formatBytes(t.br),
                    formatBytes(t.brDict),
                    delta(t.brDict, t.br),
                    formatBytes(t.zstd),
                    formatBytes(t.zstdDict),
                    delta(t.zstdDict, t.zstd)
                ]);
            }
        }

        out.push(
            table(
                [
                    "Dictionary", "Type", "Files", "Original", "gzip",
                    "br", "br+dict", "vs br", "zstd", "zstd+dict", "vs zstd"
                ],
                rows,
                ["l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "r"]
            )
        );

        //
        // Summary, best dictionary first
        //
        out.push("", "Summary (sorted by brotli savings)");

        /**
         * Brotli bytes saved by a dictionary, for sorting.
         *
         * @param {object} d Dictionary entry
         * @returns {number} Bytes saved (dictionaries with nothing to measure sort last)
         */
        const saved = (d) => (d.results.total.files ?
            d.results.total.br - d.results.total.brDict :
            Number.MIN_SAFE_INTEGER);
        const sorted = [...dicts].sort((a, b) => saved(b) - saved(a));

        out.push(
            table(
                ["Dictionary", "Dict (br)", "br saved", "zstd saved", "Break-even views"],
                sorted.map((d) => {
                    const t = d.results.total;

                    // e.g. a js dictionary when the holdout pages had no new JS
                    if (!t.files) {
                        return [
                            d.id,
                            formatBytes(d.compressed.br),
                            "n/a",
                            "n/a",
                            "n/a (no matching evaluation resources)"
                        ];
                    }

                    return [
                        d.id,
                        formatBytes(d.compressed.br),
                        `${formatBytes(t.br - t.brDict)} (${formatPercent(t.br - t.brDict, t.br)})`,
                        `${formatBytes(t.zstd - t.zstdDict)} (${formatPercent(t.zstd - t.zstdDict, t.zstd)})`,
                        d.breakEvenViews ?? "never"
                    ];
                }),
                ["l", "r", "r", "r", "r"]
            )
        );
        out.push("  Break-even = page views before the savings pay for downloading the brotli-compressed dictionary.");

        //
        // HTTP headers to deploy each dictionary
        //
        out.push("", "Serving headers (adjust match= to the URL pattern(s) the dictionary should apply to)");

        for (const d of dicts) {
            out.push(`  ${d.id}:`);
            out.push(`    Use-As-Dictionary: ${d.headers["Use-As-Dictionary"]}`);
            out.push(`    (clients will send) Available-Dictionary: ${d.headers["Available-Dictionary"]}`);
        }
    }

    if (report.skipped.length) {
        out.push("", "Skipped:");

        for (const sk of report.skipped) {
            out.push(`  ${sk.id}: ${sk.reason}`);
        }
    }

    if (report.reportFile) {
        out.push("", `Full report: ${report.reportFile}`);
    }

    return out.join("\n");
}

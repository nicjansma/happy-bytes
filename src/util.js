/**
 * Small, dependency-free helpers shared across the project.
 */

/**
 * Parses a human-friendly byte size ("64k", "1.5MB", "4096") into bytes.
 *
 * Units are binary (1k = 1024 bytes). A bare number is treated as bytes.
 *
 * @param {string|number} value Size to parse, e.g. `65536`, `"64k"`, `"1.5mb"`
 * @returns {number} Size in bytes, rounded to an integer
 * @throws {Error} If the value isn't a recognizable size
 */
export function parseSize(value) {
    // Numbers are already bytes
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.round(value);
    }

    // <number>[unit], where unit is b / k / kb / kib / m / mb / mib (case-insensitive)
    const m = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib)?\s*$/i.exec(String(value));

    if (!m) {
        throw new Error(`Invalid size: "${value}" (examples: 65536, 64k, 1m)`);
    }

    // Only the first letter of the unit matters: b(ytes), k(ilo) or m(ega)
    const unit = (m[2] || "b").toLowerCase();
    let mult = 1;

    if (unit.startsWith("k")) {
        mult = 1024;
    } else if (unit.startsWith("m")) {
        mult = 1024 * 1024;
    }

    return Math.round(parseFloat(m[1]) * mult);
}

/**
 * Formats a byte count for display, e.g. `512 B`, `12.3 KB`, `1.25 MB`.
 *
 * @param {number|null|undefined} n Byte count (may be negative)
 * @returns {string} Human-readable size, or `-` when there's no value
 */
export function formatBytes(n) {
    if (n === null || n === undefined || Number.isNaN(n)) {
        return "-";
    }

    // Format the magnitude and re-apply the sign, so -1536 becomes "-1.5 KB"
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);

    if (abs < 1024) {
        return `${sign}${abs} B`;
    }

    if (abs < 1024 * 1024) {
        return `${sign}${(abs / 1024).toFixed(1)} KB`;
    }

    return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * A function that does nothing (used as the default logger).
 *
 * @returns {void}
 */
export function noop() {
    // intentionally empty
}

/**
 * Formats `part / whole` as a percentage with one decimal, e.g. `42.5%`.
 *
 * @param {number} part Numerator
 * @param {number} whole Denominator
 * @returns {string} Percentage string, or `-` when `whole` is zero (avoids division by zero)
 */
export function formatPercent(part, whole) {
    if (!whole) {
        return "-";
    }

    return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Runs an async function over `items` with at most `limit` calls in flight at once.
 *
 * @template T, R
 * @param {T[]} items Items to process
 * @param {number} limit Maximum concurrent calls
 * @param {function(T, number): Promise<R>} fn Async function called with (item, index)
 * @returns {Promise<R[]>} Results, in the same order as `items`
 */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);

    // Index of the next item to hand out; shared by all workers
    let next = 0;

    /**
     * Pulls items off the shared queue until it's empty.
     *
     * @returns {Promise<void>} Resolves when no items remain
     */
    const worker = async() => {
        while (next < items.length) {
            // Claim an index synchronously (before awaiting) so no two workers take the same item
            const i = next++;

            results[i] = await fn(items[i], i);
        }
    };

    // Start between 1 and `limit` workers (never more workers than items)
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));

    return results;
}

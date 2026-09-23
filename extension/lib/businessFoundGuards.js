/**
 * Pure seams for BUG-4 business_found sender guards and telemetry.
 *
 * This module contains the Chrome-free sender dedupe and window telemetry seams
 * used by the content script and service worker.
 */

export const BUSINESS_FOUND_VOLATILE_FIELDS = Object.freeze(['timestamp']);
export const DEFAULT_BUSINESS_FOUND_DEDUPE_CAP = 1000;
export const DEFAULT_BUSINESS_FOUND_WINDOW_MS = 60_000;

function stableSerialize(value, seen = new Set()) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
    }
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
        result = `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`;
    } else {
        result = `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`
        )).join(',')}}`;
    }
    seen.delete(value);
    return result;
}

function firstPresentIdentity(business, identityFields) {
    if (!business || typeof business !== 'object') return null;
    for (const field of identityFields) {
        const raw = business[field];
        const value = typeof raw === 'string'
            ? raw.trim()
            : (typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '');
        if (value !== '') return { field, key: `${field}:${value}` };
    }
    return null;
}

function contentWithoutIdentity(business, identityField, volatileFields) {
    if (!business || typeof business !== 'object') return business;
    const excluded = new Set([identityField, ...volatileFields]);
    return Object.fromEntries(
        Object.entries(business).filter(([key]) => !excluded.has(key)),
    );
}

function boundedNumber(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveFiniteNumber(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Create the sender-side business observation guard.
 *
 * Final contract: shouldSend(observation) returns false only after the same
 * identity and content have already been accepted. Observations with no
 * identity always return true. `size` exposes the bounded state for tests and
 * diagnostics without exposing the mutable Map.
 */
export function createBusinessFoundDedupe(options = {}) {
    const identityFields = Array.isArray(options.identityFields) && options.identityFields.length > 0
        ? [...options.identityFields]
        : ['googleMapsUrl', 'placeId', 'cid'];
    const volatileFields = Array.isArray(options.volatileFields)
        ? [...options.volatileFields]
        : [...BUSINESS_FOUND_VOLATILE_FIELDS];
    const cap = boundedNumber(
        options.maxEntries ?? options.cap,
        DEFAULT_BUSINESS_FOUND_DEDUPE_CAP,
    );
    const entries = new Map();

    function shouldSend(observation) {
        const identity = firstPresentIdentity(observation, identityFields);
        if (identity === null) return true;

        const content = contentWithoutIdentity(observation, identity.field, volatileFields);
        const pairKey = `${identity.key}\u0000${stableSerialize(content)}`;
        if (entries.has(pairKey)) {
            entries.delete(pairKey);
            entries.set(pairKey, true);
            return false;
        }

        entries.set(pairKey, true);
        while (entries.size > cap) entries.delete(entries.keys().next().value);
        return true;
    }

    return {
        shouldSend,
        // `observe` is a readable alias for callers that model the decision as
        // an observation rather than a send gate.
        observe: shouldSend,
        clear() {
            entries.clear();
        },
        get size() {
            return entries.size;
        },
        getStateSize() {
            return entries.size;
        },
    };
}

/**
 * Create manually-advanced, windowed BUG-4 counters.
 *
 * The caller owns scheduling: call tick() or flush() from its periodic path.
 * No timer is created here, which keeps this seam importable in Node and in
 * Chrome contexts with different lifetimes.
 */
export function createBusinessFoundTelemetry(options = {}) {
    const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    const windowMs = positiveFiniteNumber(options.windowMs, DEFAULT_BUSINESS_FOUND_WINDOW_MS);
    const onWindow = typeof options.onWindow === 'function' ? options.onWindow : () => {};
    let windowStart = clock();
    if (!Number.isFinite(windowStart)) windowStart = Date.now();
    let counts = { received: 0, writes: 0, timeouts: 0 };
    let lastReport = null;

    function snapshot() {
        return {
            windowStart,
            windowEnd: windowStart + windowMs,
            ...counts,
        };
    }

    function emitWindow(windowEnd) {
        const report = {
            windowStart,
            windowEnd,
            ...counts,
        };
        lastReport = report;
        try {
            onWindow(report);
        } catch (_) {
            // Telemetry must never change message handling.
        }
        windowStart = windowEnd;
        counts = { received: 0, writes: 0, timeouts: 0 };
        return report;
    }

    function rollover(at = clock()) {
        if (!Number.isFinite(at)) return null;
        let report = null;
        while (at >= windowStart + windowMs) {
            report = emitWindow(windowStart + windowMs);
        }
        return report;
    }

    function record(kind) {
        rollover();
        counts[kind]++;
        return snapshot();
    }
    function recordReceived() { return record('received'); }
    function recordWrite() { return record('writes'); }
    function recordTimeout() { return record('timeouts'); }
    function flush() { return rollover(); }

    return {
        windowMs,
        recordReceived,
        recordWrite,
        recordTimeout,
        received: recordReceived,
        write: recordWrite,
        timeout: recordTimeout,
        rollover,
        tick: rollover,
        flush,
        snapshot,
        getCurrent: snapshot,
        getReports() {
            return lastReport ? [{ ...lastReport }] : [];
        },
        onWindow,
    };
}

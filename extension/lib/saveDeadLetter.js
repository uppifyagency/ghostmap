/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Save dead-letter queue (DLQ) — durable recovery for area-search saves that
 * fail AFTER the in-process retry in `db.saveBusiness` is exhausted.
 *
 * RCA: docs/feature/fix-area-search-save-error-swallow/rca.md (Revision v3).
 *
 * Design constraints (MV3 service worker):
 *   • Runs in the SW — NO `localStorage`, NO `window`. Uses `chrome.storage.local`,
 *     which survives BOTH SW eviction AND browser restart (unlike
 *     `chrome.storage.session`), so a dead-lettered record is recoverable next run.
 *   • `QuotaExceededError` is NEVER routed here (writing more to a full store is
 *     self-defeating). The caller (handleBusinessBatch) keeps quota on a separate
 *     fast-fail path; this module only holds TRANSIENT-but-exhausted failures.
 *   • Bounded (DLQ_CAP) — user decision: NO `unlimitedStorage` permission, so the
 *     queue stays small (~2 MB worst case) well under the ~10 MB default quota.
 *   • Drain is BUDGETED (maxRecords / maxMs) and single-pass, so recovery never
 *     stalls a run — even a full 1000-record queue can't block for minutes.
 *
 * `chrome` / `navigator` are resolved at CALL time (not import time) so this
 * module is unit-testable in pure Node with injected globals.
 */

const DLQ_KEY = 'gmp_save_dead_letter_v1';
export const DLQ_CAP = 1000;                       // bounded; oldest dropped (logged)
const AGE_OUT_MS = 14 * 24 * 60 * 60 * 1000;       // 14 days — give up on stale entries

function _local() {
    const c = (typeof chrome !== 'undefined' ? chrome : globalThis.chrome);
    if (!c || !c.storage || !c.storage.local) {
        throw new Error('[DLQ] chrome.storage.local unavailable');
    }
    return c.storage.local;
}

async function _read() {
    const got = await _local().get(DLQ_KEY);
    return (got && Array.isArray(got[DLQ_KEY])) ? got[DLQ_KEY] : [];
}

async function _write(q) {
    await _local().set({ [DLQ_KEY]: q });
}

/**
 * Persist a failed business for later re-attempt.
 * MAY reject (e.g. the DLQ write itself hits QuotaExceededError) — the caller
 * MUST wrap this in try/catch and degrade gracefully (never let it escape into
 * the batch loop, or the whole batch count is lost).
 * @param {Object} business
 * @param {string} reason - error name/message that caused the dead-letter
 * @returns {Promise<{queued:number, dropped:number}>}
 */
export async function enqueueDeadLetter(business, reason) {
    const q = await _read();
    q.push({ business, reason: String(reason || 'unknown'), ts: Date.now() });
    let dropped = 0;
    if (q.length > DLQ_CAP) {
        dropped = q.length - DLQ_CAP;
        q.splice(0, dropped); // FIFO: drop oldest
    }
    await _write(q);
    return { queued: q.length, dropped };
}

/**
 * @returns {Promise<number>} current global DLQ size (across all runs + paths).
 */
export async function getDeadLetterCount() {
    return (await _read()).length;
}

/**
 * Single-pass, budgeted drain. For each queued record, calls `saveFn(business)`
 * exactly ONCE (saveFn should be single-attempt / no-backoff — the per-record
 * retry lives in db.saveBusiness and must NOT be re-applied here). Successfully
 * re-saved records are removed; still-failing records stay for the next run.
 * Entries older than AGE_OUT_MS are dropped (counted in `agedOut`).
 *
 * @param {(business:Object)=>Promise<any>} saveFn
 * @param {{maxRecords?:number, maxMs?:number, now?:()=>number}} [opts]
 * @returns {Promise<{drained:number, remaining:number, agedOut:number, examined:number}>}
 */
export async function drainDeadLetter(saveFn, opts = {}) {
    const maxRecords = opts.maxRecords ?? 100;
    const maxMs = opts.maxMs ?? 3000;
    const now = opts.now ?? (() => Date.now());

    let q = await _read();
    if (!q.length) return { drained: 0, remaining: 0, agedOut: 0, examined: 0 };

    const start = now();
    const before = q.length;
    q = q.filter(e => (start - (e.ts || 0)) < AGE_OUT_MS);
    const agedOut = before - q.length;

    const remaining = [];
    let drained = 0, examined = 0;
    for (const entry of q) {
        // budget exhausted → preserve the rest untouched
        if (examined >= maxRecords || (now() - start) >= maxMs) {
            remaining.push(entry);
            continue;
        }
        examined++;
        try { await saveFn(entry.business); drained++; }
        catch { remaining.push(entry); }
    }
    await _write(remaining);
    return { drained, remaining: remaining.length, agedOut, examined };
}

/**
 * Re-verify ACTUAL storage pressure via navigator.storage.estimate(). Used so a
 * past quota failure does not produce a stale "storage full" alert after the
 * user has freed space — the UI signal is gated on this returning true NOW.
 * @param {number} [threshold=0.99]
 * @returns {Promise<boolean>}
 */
export async function isStorageActuallyFull(threshold = 0.99) {
    try {
        const nav = (typeof navigator !== 'undefined' ? navigator : globalThis.navigator);
        if (!nav || !nav.storage || !nav.storage.estimate) return false;
        const { usage = 0, quota = 0 } = await nav.storage.estimate();
        if (!quota) return false;
        return (usage / quota) >= threshold;
    } catch {
        return false;
    }
}

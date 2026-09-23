/**
 * Ghost Map Pro - Enrichment retry queue (v9.10, 2026-05-07)
 *
 * Closes the race between `business_found` (list-card scrape) and
 * `business_enrichment` (/maps/preview/place fetch result). Both are
 * dispatched to the SW from independent channels (DOM observer +
 * MAIN-world fetch). When enrichment arrives BEFORE saveBusiness has
 * committed the row, the IDB lookup misses and the payload is dropped
 * silently. v9.9.0 measured ~2-3% loss on this path.
 *
 * Strategy:
 *   - On lookup miss in handleBusinessEnrichment, enqueue (dbKey, payload).
 *   - 3 timer-based retries at 500ms / 1000ms / 2000ms.
 *   - Hard expiry at 30s (caps memory + handles SW dormancy edge cases).
 *   - When handleBusinessFound completes a successful save, it calls
 *     `takeIfReady(dbKey)` to drain the queued payload synchronously
 *     (faster than waiting for the next timer).
 *   - Same-key re-enqueue merges fields (additive, doesn't lose data).
 *
 * Assumptions (documented):
 *   - SW remains awake during a scrape session (continuous messages).
 *     If SW dies with queued items, they're lost — acceptable because
 *     the race window is sub-second and scraping is high-traffic.
 *   - Caller-supplied `onRetry` callback runs the actual lookup + merge;
 *     this module is just the scheduler. No recursion into enrichment
 *     handler — the callback works against a shared merge helper.
 *
 * Capacity:
 *   - Max 200 entries in flight (FIFO eviction on overflow).
 *   - Eviction logs at info — a full queue is a canary for upstream issues.
 */

import { logger } from './utils.js';

const MAX_QUEUE_SIZE = 200;
const MAX_AGE_MS = 30_000;
const RETRY_SCHEDULE_MS = [500, 1000, 2000];

// =============================================================================
// MV3 SW EVICTION POLICY — B11-6 cluster re-evaluation (2026-05-10)
// =============================================================================
//
// The original ultrareview B11-6 cluster triage flagged this file as HOT
// (would benefit from createSessionState persistence). Re-evaluation against
// the file's own header (lines 20-23) and the cluster steelman pass: the
// file documents the loss as ACCEPTABLE BY DESIGN ("If SW dies with queued
// items, they're lost — acceptable because the race window is sub-second
// and scraping is high-traffic"). The two reasons:
//
//   1. The race window enrichmentRetryQueue protects against is sub-second
//      (the gap between business_found and business_enrichment messages
//      that arrive on independent channels). During an active scrape, the
//      SW is kept alive by the message stream itself; eviction during the
//      sub-second window is statistically negligible.
//
//   2. Persisting the items would be straightforward, but the items contain
//      `onRetry` callbacks (closures from background/index.js) that are NOT
//      serializable. A persistence redesign would force an API change to
//      register a default retry handler at module load — significant
//      surface change for a sub-second race window.
//
// Decision: classify as SAFE-BY-SEMANTICS (downgraded from HOT in §11.5
// triage). Markers added below. Will revisit if production telemetry ever
// shows non-trivial loss on this path.
//
// SW-EVICTION-SAFE: items + timers die with the SW; the design assumes
// eviction during a sub-second race is statistically negligible AND the
// onRetry callbacks are non-serializable (architectural barrier to fix).
class EnrichmentRetryQueue {
    constructor() {
        this._items = new Map();
        this._stats = { enqueued: 0, drained: 0, expired: 0, capacityHits: 0 };
    }

    /**
     * Schedule retries for a (dbKey, payload) pair. Idempotent on dbKey:
     * a second enqueue for the same key MERGES fields rather than
     * replacing — protects against lost data when two enrichment
     * snapshots arrive for the same business.
     *
     * @param {string} dbKey - Canonical DB key (already normalized)
     * @param {{googleMapsUrl: string, fields: object}} payload
     * @param {(dbKey: string, payload: object) => Promise<boolean>} onRetry
     *        Returns true if the retry succeeded and the entry should drop.
     */
    enqueue(dbKey, payload, onRetry) {
        if (!dbKey || !payload || typeof onRetry !== 'function') return;

        const existing = this._items.get(dbKey);
        if (existing) {
            // Merge fields: never overwrite a populated value with empty.
            const merged = { ...existing.payload.fields };
            const incoming = payload.fields || {};
            for (const [k, v] of Object.entries(incoming)) {
                if (v != null && v !== '' && (merged[k] == null || merged[k] === '')) {
                    merged[k] = v;
                }
            }
            existing.payload.fields = merged;
            return;
        }

        if (this._items.size >= MAX_QUEUE_SIZE) {
            const oldestKey = this._items.keys().next().value;
            this._dropEntry(oldestKey);
            this._stats.capacityHits++;
            logger.info(`[RETRY] queue full (${MAX_QUEUE_SIZE}), evicted oldest: ${oldestKey}`);
        }

        const entry = {
            payload,
            attempts: 0,
            firstSeenAt: Date.now(),
            timers: []
        };

        for (const ms of RETRY_SCHEDULE_MS) {
            const t = setTimeout(() => this._fireRetry(dbKey, onRetry), ms);
            entry.timers.push(t);
        }
        const expiryTimer = setTimeout(() => this._expire(dbKey), MAX_AGE_MS);
        entry.timers.push(expiryTimer);

        this._items.set(dbKey, entry);
        this._stats.enqueued++;
    }

    /**
     * Called from handleBusinessFound after a successful save: drain the
     * queued payload (if any) synchronously. Returns the payload to merge
     * — caller is responsible for running the merge against the freshly
     * saved record.
     *
     * @param {string} dbKey
     * @returns {object|null} payload or null if nothing queued
     */
    takeIfReady(dbKey) {
        const entry = this._items.get(dbKey);
        if (!entry) return null;
        const waitMs = Date.now() - entry.firstSeenAt;
        this._dropEntry(dbKey);
        this._stats.drained++;
        logger.info(`[RETRY] drained ${dbKey} via post-save hook (waited ${waitMs}ms)`);
        return entry.payload;
    }

    async _fireRetry(dbKey, onRetry) {
        const entry = this._items.get(dbKey);
        if (!entry) return;
        entry.attempts++;
        try {
            const ok = await onRetry(dbKey, entry.payload);
            if (ok) {
                const waitMs = Date.now() - entry.firstSeenAt;
                this._dropEntry(dbKey);
                this._stats.drained++;
                logger.info(`[RETRY] drained ${dbKey} via timer (attempt ${entry.attempts}, ${waitMs}ms)`);
            }
        } catch (e) {
            logger.warn(`[RETRY] callback threw for ${dbKey}: ${e?.message}`);
        }
    }

    _expire(dbKey) {
        const entry = this._items.get(dbKey);
        if (!entry) return;
        const waitMs = Date.now() - entry.firstSeenAt;
        this._dropEntry(dbKey);
        this._stats.expired++;
        logger.info(`[RETRY] expired ${dbKey} after ${waitMs}ms (${RETRY_SCHEDULE_MS.length} attempts)`);
    }

    _dropEntry(dbKey) {
        const entry = this._items.get(dbKey);
        if (!entry) return;
        for (const t of entry.timers) clearTimeout(t);
        this._items.delete(dbKey);
    }

    getStats() {
        return {
            size: this._items.size,
            ...this._stats
        };
    }

    // Test-only.
    _reset() {
        for (const entry of this._items.values()) {
            for (const t of entry.timers) clearTimeout(t);
        }
        this._items.clear();
        this._stats = { enqueued: 0, drained: 0, expired: 0, capacityHits: 0 };
    }
}

// SW-EVICTION-SAFE: singleton dies with SW; loss documented as acceptable
// by design (see header B11-6 SW EVICTION POLICY block above).
export const enrichmentRetryQueue = new EnrichmentRetryQueue();
export { EnrichmentRetryQueue };

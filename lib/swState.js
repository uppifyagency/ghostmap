/**
 * MIT License
 * Copyright (c) 2026 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Service Worker State Helper
 *
 * MV3 SW EVICTION-SAFE state management.
 *
 * In Manifest V3, the service worker is event-driven and may be evicted
 * after ~30s of inactivity. ALL top-level mutable state (`let foo`, module-
 * level Maps/Sets/objects) is lost across eviction cycles, with no warning
 * and no crash — just silent state corruption.
 *
 * This helper wraps `chrome.storage.session` (ephemeral, eviction-safe,
 * MV3 ≥ Chrome 102) so module-level state survives wake/sleep cycles.
 *
 * Pattern (REPLACES top-level `let foo = ...`):
 *
 *   // ❌ BROKEN — perso al SW eviction:
 *   let websiteExtractionState = { isPaused: false, isRunning: false };
 *
 *   // ✅ EVICTION-SAFE:
 *   import { createSessionState } from '../lib/swState.js';
 *   const websiteExtractionState = createSessionState('website_extraction', {
 *       isPaused: false,
 *       isRunning: false
 *   });
 *
 *   // Read:
 *   const state = await websiteExtractionState.get();
 *
 *   // Mutate (replace):
 *   await websiteExtractionState.set({ isPaused: true, isRunning: true });
 *
 *   // Patch (partial merge):
 *   await websiteExtractionState.patch({ isPaused: true });
 *
 *   // Reset to default:
 *   await websiteExtractionState.clear();
 *
 * REFERENCES:
 *   - HANDOFF_MV3_SW_STATE_AUDIT.md §4 (cross-cutting recipe)
 *   - HANDOFF_ULTRAREVIEW_BLOCKS.md Block 1-12 (28 findings using this pattern)
 *   - https://developer.chrome.com/docs/extensions/reference/api/storage#property-session
 *
 * SCOPE:
 *   Use `chrome.storage.session` (ephemeral, resets on Chrome restart) for:
 *     - Run-loop state machines (isRunning, isPaused, shouldStop)
 *     - Progress counters (currentBatch, completedJobs, totalJobs)
 *     - Rate-limit / circuit-breaker state per domain
 *     - Active resource tracking (open tabs, in-flight jobs)
 *
 *   Use `chrome.storage.local` (persistent, survives Chrome restart) instead for:
 *     - User settings + preferences
 *     - Persisted job queue (already in jobQueue.js)
 *     - SessionPool sessions (already in SessionPool.js)
 *     - User data (handled by IndexedDB elsewhere)
 *
 *   Default to `session` for in-memory replacement; switch to `local` only
 *   if the data must survive a browser restart.
 */

/**
 * @typedef {Object} SessionStateAPI
 * @property {() => Promise<any>} get        Read current value (or defaultValue if unset)
 * @property {(value: any) => Promise<void>} set    Replace stored value entirely
 * @property {(partial: object) => Promise<void>} patch  Shallow-merge into stored object
 * @property {() => Promise<void>} clear     Remove key from storage (next get returns defaultValue)
 */

/**
 * Create an eviction-safe state holder backed by chrome.storage.session.
 *
 * @template T
 * @param {string} key - Storage key (must be unique across modules; suggest scope-prefix
 *                       like `'area_search.turbo_state'`).
 * @param {T} defaultValue - Returned by get() when storage has no value.
 * @returns {SessionStateAPI} State accessor object
 *
 * @example
 *   const turboState = createSessionState('area_search.turbo', {
 *       isRunning: false,
 *       currentBatch: 0
 *   });
 *   await turboState.patch({ isRunning: true });
 *   const cur = await turboState.get();  // { isRunning: true, currentBatch: 0 }
 */
export function createSessionState(key, defaultValue) {
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('createSessionState: key must be a non-empty string');
    }
    if (defaultValue === undefined) {
        throw new Error('createSessionState: defaultValue is required (use null if absence is meaningful)');
    }

    return {
        async get() {
            const r = await chrome.storage.session.get(key);
            // `r[key]` is undefined when key never set OR when value was
            // explicitly removed via clear(). Both map to defaultValue.
            return r[key] === undefined ? defaultValue : r[key];
        },

        async set(value) {
            return chrome.storage.session.set({ [key]: value });
        },

        async patch(partial) {
            if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
                throw new Error('createSessionState.patch: partial must be a plain object');
            }
            const current = await this.get();
            // For non-object current (number, string, null), patch falls back to set —
            // but typical usage is on object state. Document this asymmetry:
            if (current === null || typeof current !== 'object' || Array.isArray(current)) {
                return this.set(partial);
            }
            return this.set({ ...current, ...partial });
        },

        async clear() {
            return chrome.storage.session.remove(key);
        }
    };
}

/**
 * Convenience: install a Node-test mock of chrome.storage.session.
 *
 * For unit tests under `node tests/run-*-node.mjs`. NOT for production code.
 *
 * Returns an `{ evict }` controller that simulates SW eviction by clearing
 * the in-memory store (next get() returns defaultValue, mimicking module reload).
 *
 * @returns {{ evict: () => void }}
 *
 * @example
 *   import { installMockChromeStorage, createSessionState } from '../lib/swState.js';
 *   const { evict } = installMockChromeStorage();
 *   const state = createSessionState('test', { count: 0 });
 *   await state.patch({ count: 5 });
 *   evict();  // simulate SW eviction
 *   const cur = await state.get();  // { count: 0 } — reverted to default
 */
export function installMockChromeStorage() {
    const store = new Map();
    const target = (typeof globalThis !== 'undefined') ? globalThis : (typeof self !== 'undefined' ? self : window);
    target.chrome = target.chrome || {};
    target.chrome.storage = {
        session: {
            get: async (k) => {
                if (typeof k === 'string') {
                    return store.has(k) ? { [k]: store.get(k) } : {};
                }
                if (Array.isArray(k)) {
                    const out = {};
                    for (const key of k) {
                        if (store.has(key)) out[key] = store.get(key);
                    }
                    return out;
                }
                if (k === null || k === undefined) {
                    return Object.fromEntries(store);
                }
                throw new Error('Mock chrome.storage.session.get: unsupported key type');
            },
            set: async (obj) => {
                for (const [k, v] of Object.entries(obj)) {
                    store.set(k, v);
                }
            },
            remove: async (k) => {
                if (typeof k === 'string') {
                    store.delete(k);
                } else if (Array.isArray(k)) {
                    for (const key of k) store.delete(key);
                }
            },
            clear: async () => {
                store.clear();
            }
        }
    };
    return {
        evict: () => store.clear()
    };
}

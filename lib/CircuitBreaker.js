/**
 * =============================================================================
 * C8 FIX: UNIFIED CIRCUIT BREAKER MODULE
 * =============================================================================
 * 
 * Replaces duplicate implementations in:
 * - background/email-scraper-v2.js (sophisticated, per-domain)
 * - background/area-search.js (simple CaptchaDetector object)
 * 
 * Features:
 * - Adaptive cooldowns by error type (CAPTCHA: 5min, 429: 1min, etc.)
 * - Half-open state for gradual recovery
 * - Periodic cleanup to prevent memory growth
 * - Per-domain tracking with Map
 * - Can be used as global or domain-specific
 * 
 * Usage:
 *   // Preferred (DEBT-3 2026-05-27): frozen namespace import.
 *   import { circuitBreaker } from '../lib/CircuitBreaker.js';
 *   await circuitBreaker.recordFailure(domain, 'HTTP_429');
 *
 *   // Or named imports of individual functions.
 *   import { isCircuitOpen, recordSuccess, recordFailure } from '../lib/CircuitBreaker.js';
 *
 *   // Raw state map — for tests / introspection only.
 *   import { _circuitBreakerStateMap } from '../lib/CircuitBreaker.js';
 *
 *   if (isCircuitOpen('example.com')) {
 *       console.log('Skipping - circuit is open');
 *       return;
 *   }
 *   
 *   try {
 *       await fetchSomething();
 *       recordSuccess('example.com');
 *   } catch (error) {
 *       recordFailure('example.com', 'HTTP_429');
 *   }
 */

// =============================================================================
// CONSTANTS
// =============================================================================

const CIRCUIT_OPEN_THRESHOLD = 5;      // Failures to open circuit
const CIRCUIT_HALF_OPEN_ATTEMPTS = 2;  // Test attempts in half-open state
const CIRCUIT_MAX_AGE_MS = 3600000;    // 1 hour max age for entries
const CLEANUP_INTERVAL_MS = 300000;    // Cleanup every 5 minutes
const MAX_ENTRIES = 1000;              // Memory safety limit

// Adaptive cooldowns by error type (milliseconds)
const ADAPTIVE_COOLDOWNS = {
    // Hard blocks - need significant wait
    'CLOUDFLARE_PROTECTED': 300000,    // 5 min
    'CAPTCHA': 300000,                 // 5 min

    // Rate limits - shorter wait
    'HTTP_429': 60000,                 // 1 min
    'HTTP_403': 120000,                // 2 min
    'HTTP_503': 30000,                 // 30s

    // Network issues - try again soon
    'TIMEOUT': 15000,                  // 15s
    'EMPTY_HTML': 30000,               // 30s
    'CONNECTION_ERROR': 20000,         // 20s

    // Default
    'DEFAULT': 180000                  // 3 min
};

// =============================================================================
// STATE — MV3 SW EVICTION-SAFE (B11-6 fix)
// =============================================================================
//
// Per ultrareview B11-6 cluster: this Map was previously top-level mutable
// state lost on SW eviction (~30s idle). Damaging scenario: 50 domains in
// 5-min CAPTCHA cooldown → eviction → wake → all "healthy" → re-attempt 50
// in burst → instant re-block, multiplier doubles, anti-detection signal
// leaked.
//
// Fix design:
//   • The Map remains the in-memory truth for the current SW lifetime
//     (preserves the synchronous public API — no breaking changes for
//     callers in area-search.js).
//   • Every mutation schedules a debounced persist (100 ms) to
//     chrome.storage.session via _schedulePersist().
//   • Top-level await `_restoreFromStorage()` rehydrates the Map at
//     module load (after wake) before any consumer reads.
//   • chrome.storage.onChanged listener pulls in changes from other SW
//     contexts (improbable in practice but semantically correct).
//   • Trade-off: a 100 ms debounce window between mutation and persist
//     means an eviction landing in that window can drop the latest
//     change — single-failure-record loss, low impact.

import { createSessionState } from './swState.js';

// SW-EVICTION-SAFE: in-memory mirror; truth is also persisted via
// _circuitBreakerState (debounced write-back).
const _circuitBreakerStateMap = new Map();
// SW-EVICTION-SAFE: cleanup interval ID is module-scope; muore col SW
// e re-armato dal call top-level startCleanupTimer() su wake. Cleanup è
// idempotent + protetto da MAX_ENTRIES enforcement in recordFailure.
let cleanupTimer = null;

const _CIRCUIT_STORAGE_KEY = 'circuit_breaker.state';
const _CIRCUIT_SCHEMA_VERSION = 1;
const _circuitBreakerState = createSessionState(_CIRCUIT_STORAGE_KEY, {
    version: _CIRCUIT_SCHEMA_VERSION,
    entries: {}
});

// SW-EVICTION-SAFE: debounce timer is module-scope; eviction within the
// 100 ms window can drop the latest mutation (single failure-record loss).
let _persistDebounceTimer = null;

// LIB-5 FIX (2026-05-10): suppress self-fire of the chrome.storage.onChanged
// listener. chrome.storage.onChanged dispatches to the writer too — without
// suppression the SW would receive its own persist callback, clear() the
// in-memory Map, and re-fill it from storage, racing with concurrent
// recordSuccess / recordFailure calls. _selfWriteCounter is incremented
// before each .set() and decremented after; the listener skips events that
// arrive while the counter is > 0. We use a counter (not a boolean) so
// rapid back-to-back persists don't accidentally unmask the listener mid-
// debounce.
let _selfWriteCounter = 0;

function _schedulePersist() {
    if (_persistDebounceTimer) clearTimeout(_persistDebounceTimer);
    _persistDebounceTimer = setTimeout(async () => {
        _persistDebounceTimer = null;
        try {
            // Map → plain object for storage serialization.
            const entries = {};
            for (const [domain, state] of _circuitBreakerStateMap.entries()) {
                entries[domain] = state;
            }
            _selfWriteCounter++;
            try {
                await _circuitBreakerState.set({
                    version: _CIRCUIT_SCHEMA_VERSION,
                    entries
                });
            } finally {
                _selfWriteCounter--;
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[CIRCUIT] persist failed:', msg);
        }
    }, 100);
}

async function _restoreFromStorage() {
    try {
        const restored = await _circuitBreakerState.get();
        if (!restored || typeof restored !== 'object') return;
        if (restored.version !== _CIRCUIT_SCHEMA_VERSION) {
            console.warn(
                `[CIRCUIT] schema mismatch (got v${restored.version}, expected v${_CIRCUIT_SCHEMA_VERSION}) — discarding persisted state`
            );
            return;
        }
        const entries = restored.entries;
        if (!entries || typeof entries !== 'object') return;
        let restoredCount = 0;
        let discardedCount = 0;
        for (const [domain, state] of Object.entries(entries)) {
            // LIB-12 FIX (2026-05-10): pre-fix validated only `failures`. A
            // corrupted `openedAt` / `cooldownMultiplier` / `halfOpenAttempts`
            // could survive restore and produce NaN cooldown timing or an
            // infinitely-locked breaker. Now we full-shape validate; any field
            // that fails its type/range invariant causes the entry to be
            // dropped (log warn + count) rather than partially restored.
            if (
                state && typeof state === 'object'
                && typeof state.failures === 'number' && Number.isFinite(state.failures) && state.failures >= 0
                && typeof state.openedAt === 'number' && Number.isFinite(state.openedAt) && state.openedAt >= 0
                && typeof state.halfOpen === 'boolean'
                && typeof state.halfOpenAttempts === 'number' && Number.isFinite(state.halfOpenAttempts) && state.halfOpenAttempts >= 0
                && (state.cooldownMultiplier === undefined
                    || (typeof state.cooldownMultiplier === 'number' && Number.isFinite(state.cooldownMultiplier) && state.cooldownMultiplier > 0))
            ) {
                _circuitBreakerStateMap.set(domain, state);
                restoredCount++;
            } else {
                discardedCount++;
            }
        }
        if (discardedCount > 0) {
            console.warn(`[CIRCUIT] Discarded ${discardedCount} corrupted entries during restore`);
        }
        if (restoredCount > 0) {
            console.info(`[CIRCUIT] Restored ${restoredCount} domain entries from storage (eviction recovery)`);
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[CIRCUIT] restore failed:', msg);
    }
}

function _installChangeListener() {
    if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged?.addListener) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'session') return;
        const change = changes[_CIRCUIT_STORAGE_KEY];
        if (!change || !change.newValue) return;
        // LIB-5: skip events caused by our own .set() — see _selfWriteCounter
        // above. Without this guard, the SW's own persist callback would
        // clear() the Map mid-operation and race with concurrent recordSuccess
        // / recordFailure callers (the call sequence A.failures=1 → A.failures=2
        // could collapse to A.failures=undefined if the clear lands between
        // the read in recordFailure and its subsequent set).
        if (_selfWriteCounter > 0) return;
        // External writer (rare): full re-sync of the Map from storage.
        if (change.newValue.version !== _CIRCUIT_SCHEMA_VERSION) return;
        const entries = change.newValue.entries;
        if (!entries || typeof entries !== 'object') return;
        _circuitBreakerStateMap.clear();
        for (const [domain, state] of Object.entries(entries)) {
            if (state && typeof state === 'object'
                && typeof state.failures === 'number'
                && Number.isFinite(state.failures)) {
                _circuitBreakerStateMap.set(domain, state);
            }
        }
    });
}
_installChangeListener();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get cooldown duration based on error type
 * @param {string} errorType - Error type string
 * @returns {number} Cooldown in milliseconds
 */
function getCooldownForError(errorType) {
    if (!errorType) return ADAPTIVE_COOLDOWNS.DEFAULT;

    // LIB-11 FIX (2026-05-11): pre-fix called `.toUpperCase()` directly on
    // the argument, which throws TypeError if a future caller ever passes
    // a numeric HTTP status (e.g. `recordFailure(domain, 429)`) or any
    // non-string value. The `!errorType` guard above only catches
    // null/undefined/0/'' — `429` (truthy number) would still reach this
    // line and crash. Defensive coercion is ~ns and makes the function
    // tolerant of any toStringable input.
    const upperError = String(errorType).toUpperCase();

    // Match against known patterns
    if (upperError.includes('CLOUDFLARE')) return ADAPTIVE_COOLDOWNS.CLOUDFLARE_PROTECTED;
    if (upperError.includes('CAPTCHA')) return ADAPTIVE_COOLDOWNS.CAPTCHA;
    if (upperError.includes('429')) return ADAPTIVE_COOLDOWNS.HTTP_429;
    if (upperError.includes('403')) return ADAPTIVE_COOLDOWNS.HTTP_403;
    if (upperError.includes('503')) return ADAPTIVE_COOLDOWNS.HTTP_503;
    if (upperError.includes('TIMEOUT')) return ADAPTIVE_COOLDOWNS.TIMEOUT;
    if (upperError.includes('EMPTY')) return ADAPTIVE_COOLDOWNS.EMPTY_HTML;
    if (upperError.includes('CONNECTION') || upperError.includes('NETWORK')) {
        return ADAPTIVE_COOLDOWNS.CONNECTION_ERROR;
    }

    return ADAPTIVE_COOLDOWNS.DEFAULT;
}

/**
 * Log helper - uses console since lib may be imported before logger is available
 * @param {string} level - Log level
 * @param {string} message - Log message
 */
function log(level, message) {
    const prefix = '[CIRCUIT]';
    if (level === 'error') {
        console.error(`${prefix} ${message}`);
    } else if (level === 'warn') {
        console.warn(`${prefix} ${message}`);
    } else if (level === 'info') {
        console.info(`${prefix} ${message}`);
    } else {
        console.debug(`${prefix} ${message}`);
    }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Check if circuit is open for a domain
 * @param {string} domain - Domain to check
 * @returns {boolean} True if circuit is open (should skip)
 */
export function isCircuitOpen(domain) {
    const state = _circuitBreakerStateMap.get(domain);
    if (!state) return false;

    // Forensic #14 (2026-06-11): the half-open / cooldown machinery below
    // applies ONLY to a circuit that has actually OPENED (failures reached
    // CIRCUIT_OPEN_THRESHOLD → openedAt stamped). A sub-threshold entry
    // (1..threshold-1 transient failures) still carries openedAt=0, so the
    // `now - openedAt` elapsed check was vacuously huge and ALWAYS fired the
    // half-open branch — dragging the domain into half-open accounting,
    // consuming its trial budget over a couple of isCircuitOpen() reads (in
    // area-search isCircuitOpen is even exposed as a getter, so plain reads
    // consumed attempts), then re-opening it with failures=THRESHOLD. Net
    // effect: a SINGLE transient failure escalated to a full circuit block,
    // and the threshold check below (the intended gate) was unreachable.
    // Guard: a not-yet-open circuit is simply closed — no accounting, no reads
    // consumed.
    if (!state.openedAt || (state.failures || 0) < CIRCUIT_OPEN_THRESHOLD) {
        return false;
    }

    const now = Date.now();
    const elapsed = now - state.openedAt;
    const baseCooldownMs = getCooldownForError(state.lastError);
    const cooldownMs = baseCooldownMs * (state.cooldownMultiplier || 1);

    // Cooldown expired - transition to half-open state
    if (elapsed >= cooldownMs) {
        if (!state.halfOpen) {
            state.halfOpen = true;
            state.halfOpenAttempts = 0;
            log('info', `🔄 Domain ${domain} entering half-open state after ${(cooldownMs / 1000).toFixed(0)}s`);
            _schedulePersist(); // B11-6: persist transition
        }

        // In half-open, allow limited attempts
        if (state.halfOpenAttempts < CIRCUIT_HALF_OPEN_ATTEMPTS) {
            state.halfOpenAttempts++;
            _schedulePersist(); // B11-6: persist attempt counter
            return false; // Allow attempt
        }

        // Half-open attempts exhausted: transition back to open with extended cooldown
        // instead of permanently blocking until eviction
        state.halfOpen = false;
        state.halfOpenAttempts = 0;
        state.failures = CIRCUIT_OPEN_THRESHOLD;
        state.cooldownMultiplier = Math.min((state.cooldownMultiplier || 1) * 2, 16);
        state.openedAt = now;
        log('warn', `🔴 Domain ${domain} half-open attempts exhausted - re-opened with ${state.cooldownMultiplier}x cooldown`);
        _schedulePersist(); // B11-6: persist re-open transition
        return true;
    }

    return state.failures >= CIRCUIT_OPEN_THRESHOLD;
}

/**
 * Check if circuit is open (global - not domain specific)
 * Used by area-search for CAPTCHA detection
 * @returns {boolean} True if any critical circuit is open
 */
export function isGlobalCircuitOpen() {
    for (const [domain, state] of _circuitBreakerStateMap.entries()) {
        if (state.lastError &&
            (state.lastError.includes('CAPTCHA') || state.lastError.includes('CLOUDFLARE')) &&
            state.failures >= CIRCUIT_OPEN_THRESHOLD) {
            const elapsed = Date.now() - state.openedAt;
            const cooldownMs = getCooldownForError(state.lastError);
            if (elapsed < cooldownMs) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Get remaining cooldown for a domain
 * @param {string} domain - Domain to check
 * @returns {number} Remaining cooldown in milliseconds (0 if not blocked)
 */
export function getRemainingCooldown(domain) {
    const state = _circuitBreakerStateMap.get(domain);
    if (!state || state.failures < CIRCUIT_OPEN_THRESHOLD) return 0;

    const baseCooldownMs = getCooldownForError(state.lastError);
    const cooldownMs = baseCooldownMs * (state.cooldownMultiplier || 1);
    const elapsed = Date.now() - state.openedAt;
    return Math.max(0, cooldownMs - elapsed);
}

/**
 * Record success for a domain
 * @param {string} domain - Domain that succeeded
 */
export function recordSuccess(domain) {
    const state = _circuitBreakerStateMap.get(domain);
    if (state) {
        // Success in half-open state closes the circuit (full recovery)
        if (state.halfOpen) {
            log('info', `✅ Domain ${domain} recovered - circuit closed (cooldown multiplier reset)`);
            _circuitBreakerStateMap.delete(domain);
        } else {
            // Reduce failure count on success
            state.failures = Math.max(0, state.failures - 1);
            if (state.failures === 0) {
                _circuitBreakerStateMap.delete(domain);
            }
        }
        // B11-6: write-back to chrome.storage.session (debounced 100 ms).
        _schedulePersist();
    }
}

/**
 * Record failure for a domain
 * @param {string} domain - Domain that failed
 * @param {string} [errorType='DEFAULT'] - Error type for adaptive cooldown
 */
export function recordFailure(domain, errorType = 'DEFAULT') {
    let state = _circuitBreakerStateMap.get(domain);

    if (!state) {
        state = {
            failures: 0,
            openedAt: 0,
            halfOpen: false,
            halfOpenAttempts: 0,
            lastError: null,
            cooldownMultiplier: 1
        };
        _circuitBreakerStateMap.set(domain, state);
    }

    // Store error type for adaptive cooldown
    state.lastError = errorType;

    // If in half-open and failed, re-open the circuit with extended cooldown
    if (state.halfOpen) {
        state.halfOpen = false;
        state.halfOpenAttempts = 0;
        state.failures = CIRCUIT_OPEN_THRESHOLD;
        state.cooldownMultiplier = Math.min((state.cooldownMultiplier || 1) * 2, 16);
        state.openedAt = Date.now();
        const effectiveCooldown = getCooldownForError(state.lastError) * state.cooldownMultiplier;
        log('warn', `🔴 Domain ${domain} failed half-open test - circuit re-opened with ${state.cooldownMultiplier}x cooldown (${(effectiveCooldown / 1000).toFixed(0)}s)`);
        // B11-6: persist before early-return.
        _schedulePersist();
        return;
    }

    state.failures++;

    if (state.failures === CIRCUIT_OPEN_THRESHOLD) {
        state.openedAt = Date.now();
        const cooldownMs = getCooldownForError(errorType);
        log('warn', `⛔ Domain ${domain} circuit OPENED (${CIRCUIT_OPEN_THRESHOLD} ${errorType} failures)`);
        log('warn', `⏳ Domain ${domain} blocked for ${(cooldownMs / 60000).toFixed(1)} minutes`);
    }

    // Memory safety: enforce max entries
    if (_circuitBreakerStateMap.size > MAX_ENTRIES) {
        pruneOldestEntries();
    }

    // B11-6: write-back to chrome.storage.session (debounced 100 ms).
    _schedulePersist();
}

/**
 * Clean up stale circuit breaker entries
 */
export function cleanup() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [domain, state] of _circuitBreakerStateMap.entries()) {
        const entryAge = state.openedAt ? (now - state.openedAt) : CIRCUIT_MAX_AGE_MS;

        if (entryAge > CIRCUIT_MAX_AGE_MS) {
            _circuitBreakerStateMap.delete(domain);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        log('info', `🧹 Cleaned ${cleanedCount} stale entries (>${CIRCUIT_MAX_AGE_MS / 60000}min old)`);
        // B11-6: persist after deletions so storage doesn't keep stale entries.
        _schedulePersist();
    }

    log('debug', `Map size after cleanup: ${_circuitBreakerStateMap.size} entries`);
}

/**
 * Prune oldest entries when over max size
 */
function pruneOldestEntries() {
    const entries = [..._circuitBreakerStateMap.entries()]
        .sort((a, b) => (a[1].openedAt || 0) - (b[1].openedAt || 0));

    const toRemove = entries.slice(0, entries.length - MAX_ENTRIES);
    for (const [domain] of toRemove) {
        _circuitBreakerStateMap.delete(domain);
    }

    log('info', `🧹 Pruned ${toRemove.length} oldest entries (max: ${MAX_ENTRIES})`);
    // B11-6: persist after pruning. Caller (recordFailure) will also persist;
    // double-write is benign because of debounce.
    _schedulePersist();
}

/**
 * Get current statistics
 * @returns {Object} Circuit breaker stats
 */
export function getStats() {
    let openCircuits = 0;
    let halfOpenCircuits = 0;

    for (const state of _circuitBreakerStateMap.values()) {
        if (state.failures >= CIRCUIT_OPEN_THRESHOLD) {
            if (state.halfOpen) {
                halfOpenCircuits++;
            } else {
                openCircuits++;
            }
        }
    }

    return {
        totalDomains: _circuitBreakerStateMap.size,
        openCircuits,
        halfOpenCircuits,
        closedCircuits: _circuitBreakerStateMap.size - openCircuits - halfOpenCircuits
    };
}

/**
 * Clear all circuit breaker state
 */
export function reset() {
    _circuitBreakerStateMap.clear();
    log('info', '🔄 Circuit breaker state reset');
    // B11-6: also clear persisted storage so wake doesn't re-restore old state.
    _schedulePersist();
}

/**
 * Start periodic cleanup timer
 */
export function startCleanupTimer() {
    if (cleanupTimer) return;

    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
    log('info', `🧹 Cleanup scheduled (every ${CLEANUP_INTERVAL_MS / 60000}min)`);
}

/**
 * Stop periodic cleanup timer
 */
export function stopCleanupTimer() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
        log('info', '🛑 Cleanup timer stopped');
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

// DEBT-3 (2026-05-27) — close Root Cause A of BUG-3 RCA structurally.
//
// Pre-DEBT-3, `circuitBreaker` was exported as the raw Map state
// container — the same name the rest of the codebase used semantically
// for the API namespace. Callers that invoked
// `circuitBreaker.stopCleanupTimer()` (the BUG-3 trap) silently got
// `Map.prototype.stopCleanupTimer` which is `undefined`, so the
// duck-typed `if (typeof x.stopCleanupTimer === 'function')` guard in
// shutdownInfrastructure skipped the cleanup with no signal.
//
// Now:
//   - `_circuitBreakerStateMap` (renamed) is the raw Map; the leading
//     underscore + descriptive suffix make the trap structurally
//     impossible to walk into by mistake.
//   - `circuitBreaker` (new shape) is a frozen Object literal exposing
//     the public function surface. `Object.freeze` prevents accidental
//     reassignment of any method by consumers.
//
// The BUG-3 defensive warn in lib/infrastructure.js stays as
// belt-and-suspenders: a future regressor renaming this back would
// still be caught at runtime.
const circuitBreaker = Object.freeze({
    isCircuitOpen,
    isGlobalCircuitOpen,
    getRemainingCooldown,
    recordSuccess,
    recordFailure,
    cleanup,
    getStats,
    reset,
    startCleanupTimer,
    stopCleanupTimer,
    getCooldownForError
});

export { _circuitBreakerStateMap, ADAPTIVE_COOLDOWNS, getCooldownForError, circuitBreaker };

// 2026-05-15 REVERT (top-level-await ban): Chrome MV3 stable rejects SW
// modules with top-level `await` ("Top-level await is disallowed in
// service workers" — Status code: 3). Fire-and-forget. Race window: any
// consumer reading the Map before restore resolves sees an empty
// breaker (= treats endpoints as healthy = retries quickly), which is
// the existing cold-boot behavior — strictly safe-by-default. The
// cleanup timer is independent and starts immediately.
_restoreFromStorage()
    .catch(err => log('warn', '[CB] restore failed:', err?.message || err));

// Start cleanup timer on module load
startCleanupTimer();

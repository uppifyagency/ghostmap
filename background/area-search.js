/**
 * =====================================================
 * TURBO AREA SEARCH v3 - Enhanced Extraction
 * =====================================================
 * 
 * NOW HANDLES:
 * ✅ Standard business listings (Wedding Planners, etc.)
 * ✅ Hotels with embedded website text (galzignano.it)
 * ✅ Businesses with "Sito web" buttons
 * ✅ Phone numbers in various Italian formats
 * 
 * SECURITY HARDENED:
 * 🔒 Resource exhaustion protection
 * 🔒 Input validation and sanitization
 * 🔒 Guaranteed tab cleanup
 * 🔒 DoS attack prevention
 * 
 * ANTI-CAPTCHA FEATURES:
 * 🤖 Session management with fingerprint rotation
 * 🤖 Automatic blocking detection and recovery
 * 🤖 Comprehensive statistics tracking
 */

// =====================================================
// LEVELUP INTEGRATION - Crawlee-inspired Components
// =====================================================

import { CONFIG } from '../lib/config.js';
import { getSessionPool } from '../lib/SessionPool.js';
import { getStatistics } from '../lib/Statistics.js';
import { getTimerRegistry } from '../lib/TimerRegistry.js';
import { Mutex } from '../lib/mutex.js';
// OBS-4 (2026-05-17): import DB for finalize-time stats reconciliation. The
// per-batch accumulators (`stats.withWebsite/withPhone`) overcount because
// `_applyBatchStatsToTurbo` increments per business per grid-cell — the same
// business seen in 3 adjacent cells contributes 3× to phone count. At
// finishTurbo we overwrite with DB-truth so the completion dialog matches
// what the user sees in the main UI.
import dbInstance from '../lib/db.js';
// SAVE-DLQ (2026-05-28): drain failed saves recovered from prior runs at
// finalize, and report the queue depth. See rca.md (fix-area-search-save-error-swallow).
import { drainDeadLetter, getDeadLetterCount } from '../lib/saveDeadLetter.js';
// C8 FIX: Import unified CircuitBreaker for CAPTCHA/blocking detection
import {
    isCircuitOpen as isCircuitOpenForDomain,
    recordSuccess as recordCircuitSuccess,
    recordFailure as recordCircuitFailure,
    getRemainingCooldown,
    getStats as getCircuitStats
} from '../lib/CircuitBreaker.js';
// BUG-021 FIX: Removed unused normalizePhone import
// The inline version in executeScript is used because executeScript runs in page context
// and cannot use imported modules. See BUG-004 note in extractEnhanced function.

// Initialize session pool for anti-detection
const sessionPool = getSessionPool({
    maxPoolSize: 20,           // Max 20 sessions in pool
    maxUsageCount: 30,         // Retire session after 30 uses
    maxErrorScore: 3,          // Retire after 3 errors
    maxAgeSecs: 1800           // 30 minute max age
});

// Initialize statistics tracking
const statistics = getStatistics({
    logIntervalSecs: 120,      // Log stats every 2 minutes
    persistIntervalMs: 60000   // Persist to storage every minute
});

console.log('[LEVELUP] SessionPool and Statistics initialized');

// =============================================================================
// ANTI-DETECTION HUMANIZATION MODULE
// =============================================================================

const HumanBehavior = {
    // Gaussian delay (Box-Muller transform for natural randomization)
    gaussianDelay(mean, stdDev) {
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.max(0, mean + z * stdDev);
    },

    // Variable delay between actions
    async humanDelay(minMs = 500, maxMs = 2000) {
        const delay = this.gaussianDelay((minMs + maxMs) / 2, (maxMs - minMs) / 4);
        await sleep(delay);
    },

    // Random chance to pause longer (simulating distraction)
    async occasionalPause(probability = 0.15, pauseMs = 3000) {
        if (Math.random() < probability) {
            console.log('[HUMAN] Taking a break...');
            await sleep(pauseMs + Math.random() * 2000);
        }
    },

    // Shuffle array to break sequential patterns
    shuffle(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    },

    // Add jitter to coordinates
    jitterCoordinate(value, maxJitter = 0.001) {
        return value + (Math.random() - 0.5) * 2 * maxJitter;
    }
};

// =============================================================================
// CAPTCHA DETECTION & CIRCUIT BREAKER
// C8 FIX: Now delegates to unified CircuitBreaker module for consistent behavior
// =============================================================================

const CAPTCHA_DOMAIN = '_global_captcha_'; // Special domain for global CAPTCHA tracking

const CaptchaDetector = {
    consecutiveFailures: 0,

    async checkForCaptcha(tabId) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const html = document.body?.innerHTML || '';
                    const signals = [
                        html.includes('unusual traffic'),
                        html.includes('not a robot'),
                        html.includes('captcha'),
                        html.includes('challenge-running'),
                        document.querySelector('iframe[src*="recaptcha"]'),
                        document.querySelector('#captcha'),
                        document.title.includes('unusual traffic')
                    ];
                    return signals.some(Boolean);
                }
            });
            return results?.[0]?.result || false;
        } catch {
            return false;
        }
    },

    // C8 FIX: Delegate to unified CircuitBreaker
    reportFailure() {
        this.consecutiveFailures++;
        console.warn(`[CAPTCHA] Failure count: ${this.consecutiveFailures}`);

        if (this.consecutiveFailures >= 3) {
            // Use unified circuit breaker with CAPTCHA error type
            recordCircuitFailure(CAPTCHA_DOMAIN, 'CAPTCHA');
            console.error('[CAPTCHA] Circuit breaker OPEN via unified module');

            // B12-2 FIX (2026-05-10): UI listener wired in ui/sidepanel.js
            // (Activity Feed entry + error toast) and ui/area-search-modal.js
            // (in-modal warning banner). PO decision was made: surface the
            // signal to the user — invisible CAPTCHA detection caused users
            // to think the extension was broken when scraping silently halted.
            // .catch(()=>{}) absorbs the "Receiving end does not exist"
            // error when both sidepanel and modal are closed (rare but valid).
            chrome.runtime.sendMessage({
                action: 'area_search_captcha_detected',
                payload: {
                    cooldownMs: getRemainingCooldown(CAPTCHA_DOMAIN),
                    resumeAt: Date.now() + getRemainingCooldown(CAPTCHA_DOMAIN)
                }
            }).catch(() => { });
        }
    },

    // C8 FIX: Delegate to unified CircuitBreaker
    reportSuccess() {
        this.consecutiveFailures = 0;
        recordCircuitSuccess(CAPTCHA_DOMAIN);
    },

    // C8 FIX: Delegate to unified CircuitBreaker
    canProceed() {
        const isOpen = isCircuitOpenForDomain(CAPTCHA_DOMAIN);
        if (!isOpen && this.consecutiveFailures >= 3) {
            // Circuit recovered
            console.log('[CAPTCHA] Circuit breaker CLOSED via unified module');
            this.consecutiveFailures = 0;
        }
        return !isOpen;
    },

    // C8 FIX: Delegate to unified CircuitBreaker
    getRemainingCooldown() {
        return getRemainingCooldown(CAPTCHA_DOMAIN);
    },

    // Keep for backward compatibility
    get isCircuitOpen() {
        return isCircuitOpenForDomain(CAPTCHA_DOMAIN);
    },

    get cooldownMs() {
        return getRemainingCooldown(CAPTCHA_DOMAIN);
    }
};

console.log('[HUMANIZATION] HumanBehavior and CaptchaDetector initialized (C8: unified circuit breaker)');

// =====================================================
// SECURITY CONSTRAINTS
// =====================================================
// NSA-grade security limits to prevent resource exhaustion and DoS attacks

const SECURITY_LIMITS = {
    MAX_PARALLEL_TABS: 12,          // Restored: Allow 4-12 tabs as per dropdown options
    MAX_RADIUS_KM: 200,             // Prevent grid explosion
    MIN_SPACING_KM: 5,              // Prevent grid explosion
    MAX_KEYWORDS: 20,               // Prevent combinatorial explosion
    MAX_GRID_POINTS: 1000,          // Total search points limit
    MAX_TOTAL_SEARCHES: 5000,       // Total searches per session
    TAB_CREATION_TIMEOUT_MS: 5000,  // Timeout per tab creation
    BATCH_CLEANUP_TIMEOUT_MS: 10000,// Max time for cleanup
    MAX_CITY_NAME_LENGTH: 100,      // Prevent injection attacks
    MAX_KEYWORD_LENGTH: 100,        // Prevent payload attacks
    MAX_CONSECUTIVE_BATCH_ERRORS: 3 // Abort after N consecutive batch failures
};

// =====================================================
// OPTIMAL GRID CONFIGURATION
// =====================================================
// Empirically tuned for Google Maps search optimization

const GRID_OPTIMIZER = {
    GOOGLE_EFFECTIVE_RADIUS_KM: 4,      // Maps returns ~4km radius
    HEX_PACKING_FACTOR: Math.sqrt(3),   // Optimal: 1.732
    MIN_OPTIMAL_SPACING: 6.9,           // 4 * √3 ≈ 6.9km

    // Early termination thresholds
    MAX_CONSECUTIVE_LOW_YIELD: 3,
    LOW_YIELD_THRESHOLD: 2,             // < 2 new businesses = low yield
    HIGH_DUPLICATE_THRESHOLD: 0.8       // 80% duplicates
};

// =====================================================
// MESSAGE QUEUE SECURITY LIMITS
// =====================================================
// SECURITY: Prevent message queue overflow and extension crashes
// Chrome message passing limits: ~100KB-1MB (context-dependent)
// Attack vector: Large batches with all fields populated can exceed limits

const MESSAGE_LIMITS = {
    MAX_MESSAGE_SIZE_BYTES: 64 * 1024,   // 64KB safe limit
    MAX_BATCH_SIZE: 10,                   // Businesses per message
    MESSAGE_THROTTLE_MS: 50,              // Min delay between messages
    MAX_PENDING_MESSAGES: 3,              // Concurrent message cap
    SIZE_ESTIMATE_OVERHEAD: 1.2           // JSON overhead (20%)
};

// =====================================================
// CONFIGURATION
// =====================================================

const TURBO_CONFIG = {
    parallelTabs: 6,           // PHASE 1 OPTIMIZED: 6 tabs default (was 3, +100%)
    pageLoadWait: 3000,        // Wait for initial load
    scrollDuration: 45000,     // DYNAMIC: Up to 150 scrolls * ~300ms avg = ~45s
    extractionWait: 2000,      // Wait before extraction
    batchDelay: 300            // PHASE 1 OPTIMIZED: Shorter delay (was 500)
};

// =====================================================
// STATE — MV3 SW EVICTION-SAFE (B3-1 fix)
// =====================================================
//
// TURBO_STATE was previously a module-scope `const` object. In Manifest V3
// the service worker is event-driven and may be evicted after ~30s idle —
// ALL top-level mutable state is then lost. A 25-min area-search run could
// die silently mid-batch (HANDOFF_ULTRAREVIEW_BLOCKS.md B3-1 P0 CATASTROFICO).
//
// Fix: persist TURBO_STATE to chrome.storage.session (eviction-safe) via
// debounced auto-persist, restore at module load (top-level await), and
// re-attach the run loop if state.isRunning post-restore — rescuing the
// in-progress scrape that was interrupted by eviction.
//
// Implementation:
//   • `_turboInMemory` is the actual object accessed by all callers.
//   • `TURBO_STATE` is a Proxy that intercepts top-level writes and triggers
//     debounced persist (100ms). Reads pass through unchanged.
//   • Nested mutations (TURBO_STATE.stats.foo = X, openTabs.add) DON'T
//     trigger the Proxy set trap — call sites that need them now use the
//     replacement pattern (TURBO_STATE.stats = {...TURBO_STATE.stats, foo: X})
//     OR call `_schedulePersist()` explicitly.
//   • Set is serialized as Array for storage (chrome.storage.session can't
//     serialize Set directly).

const _TURBO_DEFAULTS = Object.freeze({
    isRunning: false,
    isPaused: false,
    currentBatch: 0,
    totalBatches: 0,
    completedSearches: 0,
    totalSearches: 0,
    searches: [],
    startTime: null,
    consecutiveLowYield: 0,
    stats: { businessesFound: 0, withWebsite: 0, withPhone: 0, withEmail: 0 },
    config: {}
});

// SW-EVICTION-SAFE: backed by chrome.storage.session via Proxy + auto-persist.
// Nested mutations require explicit _schedulePersist() — see comment above.
/** @type {Record<string, any>} */
const _turboInMemory = {
    isRunning: false,
    isPaused: false,
    currentBatch: 0,
    totalBatches: 0,
    completedSearches: 0,
    totalSearches: 0,
    searches: [],
    startTime: null,
    consecutiveLowYield: 0,
    stats: { businessesFound: 0, withWebsite: 0, withPhone: 0, withEmail: 0 },
    config: {},
    openTabs: new Set()
};

const _TURBO_STORAGE_KEY = 'area_search.turbo_state';
const _TURBO_SCHEMA_VERSION = 1;
/** @type {ReturnType<typeof setTimeout> | null} */
let _persistDebounceTimer = null;
let _persistLeadingInFlight = false;

async function _doPersist() {
    try {
        await chrome.storage.session.set({
            [_TURBO_STORAGE_KEY]: {
                version: _TURBO_SCHEMA_VERSION,
                ..._turboInMemory,
                openTabs: Array.from(_turboInMemory.openTabs)
            }
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[TURBO_STATE] persist failed:', msg);
    }
}

// BG-9 FIX (2026-05-11): pre-fix was trailing-edge debounce only —
// every write scheduled a 100ms timer and earlier timers were
// cleared. If the SW was evicted within that 100ms window (e.g.
// idle-shutdown, navigation-induced unload), the in-memory mutation
// was never flushed and the next SW respawn read stale state from
// chrome.storage.session, silently losing the write.
//
// Fix: leading-edge + trailing-edge. The first mutation of a burst
// triggers an immediate persist (fire-and-forget), capturing state
// at T0 before potential eviction. Subsequent mutations within the
// 100ms window still coalesce into a single trailing-edge write,
// preserving the original batching benefit. Worst-case lost-write
// window shrinks from "up to 100ms" to "the gap between two
// mutations inside the same burst" — usually sub-ms in practice.
function _schedulePersist() {
    // Leading edge: fire immediate persist if neither a debounce timer
    // nor a leading write is currently in flight. The in-flight guard
    // prevents fan-out (one leading write per burst), not concurrency
    // safety — the chrome.storage.session.set call itself is serialized
    // by the browser per-key.
    if (!_persistDebounceTimer && !_persistLeadingInFlight) {
        _persistLeadingInFlight = true;
        _doPersist().finally(() => { _persistLeadingInFlight = false; });
    }
    // Trailing edge: original behavior, batches any subsequent writes.
    if (_persistDebounceTimer) clearTimeout(_persistDebounceTimer);
    _persistDebounceTimer = setTimeout(async () => {
        _persistDebounceTimer = null;
        await _doPersist();
    }, 100);
}

/**
 * Type-validated field restore. Rejects writes whose runtime type doesn't
 * match the default's type — prevents storage-corruption / schema-drift
 * from injecting arbitrary properties that change run-loop control flow.
 *
 * Specific guards:
 *   - boolean defaults: only accept boolean values
 *   - number defaults: only accept finite numbers (NaN/Infinity rejected)
 *   - string-or-null defaults: accept string or null
 *   - array defaults: only accept Array
 *   - object defaults: only accept plain object (rejects array/null)
 *
 * @param {any} defaultValue - The reference type (from _TURBO_DEFAULTS)
 * @param {any} restoredValue - The candidate value from storage
 * @returns {boolean} true if restoredValue is type-compatible with defaultValue
 */
function _isValidRestoreValue(defaultValue, restoredValue) {
    if (restoredValue === undefined) return false;
    if (defaultValue === null) {
        // startTime: number | null
        return restoredValue === null || typeof restoredValue === 'number';
    }
    if (typeof defaultValue === 'boolean') return typeof restoredValue === 'boolean';
    if (typeof defaultValue === 'number') {
        return typeof restoredValue === 'number' && Number.isFinite(restoredValue);
    }
    if (Array.isArray(defaultValue)) return Array.isArray(restoredValue);
    if (typeof defaultValue === 'object') {
        return restoredValue !== null
            && typeof restoredValue === 'object'
            && !Array.isArray(restoredValue);
    }
    return false;
}

async function _restoreTurboState() {
    try {
        const r = await chrome.storage.session.get(_TURBO_STORAGE_KEY);
        const restored = r[_TURBO_STORAGE_KEY];
        if (!restored || typeof restored !== 'object') return false;

        // Schema version check — drop incompatible state rather than risk
        // assigning fields whose semantics changed across versions.
        if (restored.version !== _TURBO_SCHEMA_VERSION) {
            console.warn(
                `[TURBO_STATE] schema mismatch (got v${restored.version}, expected v${_TURBO_SCHEMA_VERSION}). ` +
                `Discarding persisted state.`
            );
            await chrome.storage.session.remove(_TURBO_STORAGE_KEY);
            return false;
        }

        // Restore each known field with strict type validation.
        // Forward-compat: unknown keys in `restored` are ignored.
        // Cast _TURBO_DEFAULTS to Record<string, any> for indexing (frozen object's
        // inferred type is too strict for dynamic key iteration).
        const defaults = /** @type {Record<string, any>} */ (_TURBO_DEFAULTS);
        let restoredFieldCount = 0;
        for (const key of Object.keys(defaults)) {
            if (_isValidRestoreValue(defaults[key], restored[key])) {
                _turboInMemory[key] = restored[key];
                restoredFieldCount++;
            } else if (restored[key] !== undefined) {
                console.warn(
                    `[TURBO_STATE] field "${key}" type mismatch — ` +
                    `expected ${typeof defaults[key]}, got ${typeof restored[key]}. ` +
                    `Using default.`
                );
            }
        }
        // Set is stored as Array — re-construct, defensively reject non-arrays.
        _turboInMemory.openTabs = new Set(
            Array.isArray(restored.openTabs) ? restored.openTabs : []
        );

        console.log(
            `[TURBO_STATE] Restored ${restoredFieldCount} fields from storage: ` +
            `isRunning=${_turboInMemory.isRunning}, ` +
            `currentBatch=${_turboInMemory.currentBatch}/${_turboInMemory.totalBatches}, ` +
            `searches=${_turboInMemory.searches.length}, ` +
            `openTabs=${_turboInMemory.openTabs.size}`
        );
        return true;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[TURBO_STATE] restore failed:', msg);
        return false;
    }
}

// SW-EVICTION-SAFE: Proxy auto-persists top-level writes. Reads are pass-through.
const TURBO_STATE = new Proxy(_turboInMemory, {
    set(target, key, value) {
        /** @type {any} */ (target)[key] = value;
        _schedulePersist();
        return true;
    }
});

// 2026-05-15 REVERT (top-level-await ban): Chrome MV3 stable rejects SW
// modules containing top-level `await` ("Top-level await is disallowed in
// service workers" — Status code: 3 at registration). Converted to
// fire-and-forget. Eviction-recovery dispatch moved into the .then() so it
// still observes restored state. The race is benign: any consumer that
// reads TURBO_STATE before _restoreTurboState resolves sees the zero-init
// values, identical to a fresh SW boot — and re-attach via .then() still
// fires once restore completes. Originally added for B3-1 / B3-3 recovery.
let _runLoopActive = false;
_restoreTurboState()
    .then(() => {
        if (_turboInMemory.isRunning && _turboInMemory.searches.length > 0) {
            console.log('[TURBO_STATE] Eviction recovery: respawning run loop');
            queueMicrotask(() => {
                if (!_runLoopActive) {
                    _runLoopActive = true;
                    // AS-01 FIX (2026-06-10): the interrupted batch's popups are
                    // orphans (their owner loop died with the SW). Close them
                    // BEFORE the respawned loop redoes the batch and creates new
                    // windows — pre-fix they lingered until a manual Stop.
                    _closeOrphanWindows('TURBO_STATE respawn')
                        .catch(err => console.warn('[TURBO_STATE] orphan sweep failed:', err?.message || err))
                        .then(() => runTurboV3())
                        .catch(err => console.error('[TURBO_STATE] Re-attached run loop crashed:', err))
                        .finally(() => { _runLoopActive = false; });
                }
            });
        }
    })
    .catch(err => console.warn('[TURBO_STATE] restore failed:', err?.message || err));

// SW-EVICTION-SAFE: Mutex held only within a single SW lifetime. Any mutex
// held at eviction time dies with the function call; fresh mutex on next
// wake has no contention with old (dead) work. No persistence needed.
const tabCleanupMutex = new Mutex();

// ═══════════════════════════════════════════════════════════════════════════
// B3-3 P0 FIX: Window-marker ledger for safe stopTurbo fallback
// ─────────────────────────────────────────────────────────────────────────
// Pre-fix: stopTurbo's emergency fallback queried `chrome.tabs.query({})` and
// closed ALL Google-Maps tabs except the active one. This destroyed the user's
// own Maps tabs (research workflows, multi-tab navigation) when the in-memory
// `TURBO_STATE.openTabs` Set was empty after SW eviction or premature cleanup.
//
// Fix: tag each popup window we create with a session-scoped marker stored in
// chrome.storage.session. The fallback closes ONLY tracked windows — never
// the user's own tabs. If the ledger is empty, fallback is a no-op (safer).
//
// Session marker is generated once per browser session (stable across SW
// eviction within the same session — chrome.storage.session retains across
// SW restarts but resets on Chrome restart, which is the right scope).
// ═══════════════════════════════════════════════════════════════════════════

const _SESSION_MARKER_KEY = 'area_search.session_marker';
const _TRACKED_WINDOWS_KEY = 'area_search.tracked_windows';

/**
 * Get-or-create the per-session marker. Lazy + cached in module scope. The
 * cached value is fine to lose on eviction — next call regenerates from
 * storage if storage still has it, or creates a new one if not.
 *
 * @returns {Promise<string>}
 * @private
 */
/** @type {string | null} */
let _sessionMarkerCache = null;
async function _getSessionMarker() {
    if (_sessionMarkerCache) return _sessionMarkerCache;
    try {
        const r = await chrome.storage.session.get(_SESSION_MARKER_KEY);
        if (typeof r[_SESSION_MARKER_KEY] === 'string' && r[_SESSION_MARKER_KEY].length > 0) {
            _sessionMarkerCache = r[_SESSION_MARKER_KEY];
            return _sessionMarkerCache;
        }
        // Generate a fresh marker — non-cryptographic randomness is fine here
        // (this is a label, not a secret).
        _sessionMarkerCache = 'gmp-' + Math.random().toString(36).slice(2, 14) + '-' + Date.now().toString(36);
        await chrome.storage.session.set({ [_SESSION_MARKER_KEY]: _sessionMarkerCache });
        return _sessionMarkerCache;
    } catch (e) {
        // Storage failure should not break the scrape. Generate an in-memory
        // marker (won't survive eviction but better than nothing).
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[area-search] session marker storage failed, using in-memory:', msg);
        const fallback = _sessionMarkerCache !== null
            ? _sessionMarkerCache
            : ('gmp-mem-' + Math.random().toString(36).slice(2, 14));
        _sessionMarkerCache = fallback;
        return fallback;
    }
}

/**
 * Add a window to the tracked-windows ledger. Called immediately after
 * chrome.windows.create succeeds.
 *
 * @param {number} windowId
 * @returns {Promise<void>}
 * @private
 */
async function _trackWindow(windowId) {
    if (typeof windowId !== 'number') return;
    try {
        const marker = await _getSessionMarker();
        const r = await chrome.storage.session.get(_TRACKED_WINDOWS_KEY);
        /** @type {Record<string, string>} */
        const tracked = (r[_TRACKED_WINDOWS_KEY] && typeof r[_TRACKED_WINDOWS_KEY] === 'object')
            ? r[_TRACKED_WINDOWS_KEY] : {};
        tracked[String(windowId)] = marker;
        await chrome.storage.session.set({ [_TRACKED_WINDOWS_KEY]: tracked });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[area-search] _trackWindow failed:', msg);
    }
}

/**
 * Remove a window from the tracked-windows ledger. Called after successful
 * chrome.windows.remove (or any path where we no longer want to track the
 * window — e.g., user closed it manually).
 *
 * @param {number} windowId
 * @returns {Promise<void>}
 * @private
 */
async function _untrackWindow(windowId) {
    if (typeof windowId !== 'number') return;
    try {
        const r = await chrome.storage.session.get(_TRACKED_WINDOWS_KEY);
        const tracked = r[_TRACKED_WINDOWS_KEY];
        if (!tracked || typeof tracked !== 'object') return;
        if (!(String(windowId) in tracked)) return;
        delete tracked[String(windowId)];
        await chrome.storage.session.set({ [_TRACKED_WINDOWS_KEY]: tracked });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[area-search] _untrackWindow failed:', msg);
    }
}

/**
 * Read the tracked windows ledger. Filters out entries whose marker doesn't
 * match the current session — guards against ledger from a previous Chrome
 * session (defensive; chrome.storage.session normally clears on browser restart
 * but treat this as belt-and-suspenders).
 *
 * @returns {Promise<number[]>} Array of windowIds owned by THIS session
 * @private
 */
async function _getTrackedWindowIds() {
    try {
        const marker = await _getSessionMarker();
        const r = await chrome.storage.session.get(_TRACKED_WINDOWS_KEY);
        const tracked = r[_TRACKED_WINDOWS_KEY];
        if (!tracked || typeof tracked !== 'object') return [];
        const out = [];
        for (const [wIdStr, mark] of Object.entries(tracked)) {
            if (mark === marker) {
                const wId = parseInt(wIdStr, 10);
                if (Number.isFinite(wId)) out.push(wId);
            }
        }
        return out;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[area-search] _getTrackedWindowIds failed:', msg);
        return [];
    }
}

// SW-EVICTION-SAFE: Sentinel exists only during a runTurboV3() call. At
// eviction the call dies, and the next wake re-creates it via runTurboV3()
// (either user-triggered or our re-attach above). stopTurbo's await on
// the sentinel handles the case where it's null (skip wait — nothing to drain).
// F-03 lifecycle pattern; cross-eviction semantics: "no carry-over".
let _runLoopSentinel = null;
function _makeRunLoopSentinel() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, signal: () => resolve() };
}

/**
 * Reset TURBO_STATE to prevent memory leaks AND clear persisted storage.
 * CRITICAL: Clears accumulated searches array and resets all state.
 *
 * Operates on `_turboInMemory` directly (not via TURBO_STATE Proxy) to
 * batch all field updates into a single _schedulePersist() call. Also
 * resets openTabs to a fresh Set (Proxy doesn't intercept .clear()).
 */
function resetTurboState() {
    _turboInMemory.searches = [];
    _turboInMemory.currentBatch = 0;
    _turboInMemory.totalBatches = 0;
    _turboInMemory.completedSearches = 0;
    _turboInMemory.totalSearches = 0;
    _turboInMemory.isRunning = false;
    _turboInMemory.isPaused = false;
    _turboInMemory.startTime = null;
    _turboInMemory.consecutiveLowYield = 0;
    _turboInMemory.stats = {
        businessesFound: 0,
        withWebsite: 0,
        withPhone: 0,
        withEmail: 0
    };
    _turboInMemory.config = {};
    _turboInMemory.openTabs = new Set();

    // Single persist for all the above. _persistDebounceTimer ensures we
    // don't spam storage writes during a batch reset.
    _schedulePersist();

    console.log('[MEMORY] TURBO_STATE reset - memory leak prevented');
}

// =====================================================
// CITIES
// =====================================================

/**
 * BLOCK-9 FIX (LOW-001): Pre-defined Italian city coordinates for area search
 * 
 * This is a simple lookup table for the most commonly searched Italian cities.
 * For cities not in this list, the system uses the Google Maps geocoding API 
 * via the search URL to get coordinates dynamically.
 * 
 * FUTURE IMPROVEMENT: Consider integrating a geocoding service (e.g., OpenStreetMap 
 * Nominatim, Google Geocoding API) for dynamic city lookup to support any location.
 * 
 * @type {Object.<string, {lat: number, lon: number}>}
 */
const CITIES = {
    'modena': { lat: 44.6471, lon: 10.9252 },
    'bologna': { lat: 44.4949, lon: 11.3426 },
    'milano': { lat: 45.4642, lon: 9.1900 },
    'roma': { lat: 41.9028, lon: 12.4964 },
    'firenze': { lat: 43.7696, lon: 11.2558 },
    'venezia': { lat: 45.4408, lon: 12.3155 },
    'torino': { lat: 45.0703, lon: 7.6869 },
    'napoli': { lat: 40.8518, lon: 14.2681 },
    'padova': { lat: 45.4064, lon: 11.8768 },
    'verona': { lat: 45.4384, lon: 10.9916 },
    'parma': { lat: 44.8015, lon: 10.3279 },
    'genova': { lat: 44.4056, lon: 8.9463 },
    'bari': { lat: 41.1171, lon: 16.8719 }
};

/**
 * Ephemeral runtime geocode cache (Fix A-CF3).
 *
 * Distinct from the curated CITIES allow-list: dynamically-resolved coordinates
 * are stored HERE, never written into CITIES. This avoids cache-poisoning the
 * curated table for the service-worker lifetime, so a corrected entry or code
 * fix can take effect and a runtime result never masquerades as ground-truth.
 *
 * @type {Map<string, {lat: number, lon: number}>}
 */
const GEOCODE_CACHE = new Map();

/**
 * Settlement addresstypes: a populated place whose centroid IS a valid search
 * center. Accepted unconditionally (rank order wins), regardless of bbox span,
 * so legitimately large cities (London, Berlin, Los Angeles) are never
 * span-rejected.
 */
const SETTLEMENT_TYPES = new Set([
    'city', 'town', 'village', 'municipality', 'hamlet', 'borough', 'suburb'
]);

/** Province/region/state-scale boundary cutoff (degrees). ~130 km. */
const MAX_AREA_SPAN_DEG = 1.2;

/**
 * Latitude/longitude span (degrees) of a Nominatim boundingbox.
 * boundingbox = [latMin, latMax, lonMin, lonMax] (strings).
 * Returns Infinity for a missing/malformed box so it fails the span gate.
 * @param {Object} r - raw Nominatim result
 * @returns {number}
 */
function bboxSpanDeg(r) {
    const bb = (r && r.boundingbox || []).map(parseFloat);
    if (bb.length !== 4 || bb.some(n => !Number.isFinite(n))) return Infinity;
    return Math.max(Math.abs(bb[1] - bb[0]), Math.abs(bb[3] - bb[2]));
}

/**
 * Is this raw Nominatim result a usable search center?
 *   (a) settlement: addresstype OR type ∈ SETTLEMENT_TYPES → always accept; OR
 *   (b) NOT an administrative boundary (class==='boundary' && type==='administrative')
 *       AND both lat-span and lon-span ≤ MAX_AREA_SPAN_DEG.
 * Province/region/state centroids are rejected; their centroid is tens of km
 * from the actual city.
 * @param {Object} r - raw Nominatim result
 * @returns {boolean}
 */
function isUsableCenter(r) {
    if (!r) return false;
    if (SETTLEMENT_TYPES.has(r.addresstype) || SETTLEMENT_TYPES.has(r.type)) return true;
    const isAdminBoundary = r.class === 'boundary' && r.type === 'administrative';
    if (isAdminBoundary) return false;
    return bboxSpanDeg(r) <= MAX_AREA_SPAN_DEG;
}

/**
 * PURE: select the search-center result from a parsed Nominatim array.
 *
 * Rank-preserving — iterate in Nominatim's own importance order and pick the
 * FIRST result that qualifies as a usable center (isUsableCenter). If none
 * qualify, fall back to results[0]. Returns null for an empty/invalid input.
 *
 * Deliberately NOT "smallest" (that would pick the 1-sq-mile City of London
 * over Greater London). The 1.2° gate applies ONLY to non-settlement
 * candidates, so large cities pass via the settlement branch.
 *
 * No network, no side effects.
 * @param {Array<Object>} results - parsed Nominatim JSON array
 * @returns {Object|null} chosen raw result, or null
 */
function selectGeocodeResult(results) {
    if (!Array.isArray(results) || results.length === 0) return null;
    return results.find(isUsableCenter) || results[0];
}

// =====================================================
// SECURITY VALIDATION
// =====================================================

/**
 * Validate and sanitize area search configuration
 * SECURITY: Prevents resource exhaustion, injection attacks, and DoS
 * @param {Object} config - Raw configuration from user
 * @returns {Object} Sanitized and validated configuration
 * @throws {Error} If validation fails with detailed error messages
 */
function validateAreaSearchConfig(config) {
    const errors = [];

    // ========== CITY VALIDATION ==========
    if (!config.city || typeof config.city !== 'string') {
        errors.push('City is required and must be a string');
    } else if (config.city.length > SECURITY_LIMITS.MAX_CITY_NAME_LENGTH) {
        errors.push(`City name exceeds maximum length (${SECURITY_LIMITS.MAX_CITY_NAME_LENGTH} characters)`);
    } else if (!/^[a-zA-Z0-9\s,.-]+$/.test(config.city)) {
        errors.push('City name contains invalid characters (only letters, numbers, spaces, commas, dots, hyphens allowed)');
    }

    // ========== RADIUS VALIDATION ==========
    if (typeof config.radiusKm !== 'number') {
        errors.push('Radius must be a number');
    } else if (!Number.isFinite(config.radiusKm)) {
        errors.push('Radius must be a finite number');
    } else if (config.radiusKm <= 0) {
        errors.push('Radius must be positive');
    } else if (config.radiusKm > SECURITY_LIMITS.MAX_RADIUS_KM) {
        errors.push(`Radius exceeds maximum (${SECURITY_LIMITS.MAX_RADIUS_KM}km) - reduce radius to prevent resource exhaustion`);
    }

    // ========== KEYWORDS VALIDATION ==========
    if (!Array.isArray(config.keywords)) {
        errors.push('Keywords must be an array');
    } else if (config.keywords.length === 0) {
        errors.push('At least one keyword is required');
    } else if (config.keywords.length > SECURITY_LIMITS.MAX_KEYWORDS) {
        errors.push(`Too many keywords (max ${SECURITY_LIMITS.MAX_KEYWORDS}) - reduce keywords to prevent resource exhaustion`);
    }

    // Sanitize keywords
    const sanitizedKeywords = config.keywords
        .map(k => String(k).trim())
        .filter(k => k.length > 0 && k.length <= SECURITY_LIMITS.MAX_KEYWORD_LENGTH);

    if (sanitizedKeywords.length === 0) {
        errors.push('No valid keywords after sanitization');
    }

    if (sanitizedKeywords.length !== config.keywords.length) {
        const removed = config.keywords.length - sanitizedKeywords.length;
        console.warn(`[SECURITY] Removed ${removed} invalid keywords during sanitization`);
    }

    // ========== SPACING VALIDATION ==========
    const spacingKm = config.spacingKm || 10;
    if (typeof spacingKm !== 'number' || !Number.isFinite(spacingKm)) {
        errors.push('Spacing must be a finite number');
    } else if (spacingKm < SECURITY_LIMITS.MIN_SPACING_KM) {
        errors.push(`Spacing too small (min ${SECURITY_LIMITS.MIN_SPACING_KM}km) - increase spacing to prevent grid explosion`);
    }

    // ========== PARALLEL TABS VALIDATION ==========
    const parallelTabs = config.parallelTabs || 6;
    if (typeof parallelTabs !== 'number' || !Number.isFinite(parallelTabs)) {
        errors.push('Parallel tabs must be a finite number');
    } else if (parallelTabs < 1) {
        errors.push('Parallel tabs must be at least 1');
    } else if (parallelTabs > SECURITY_LIMITS.MAX_PARALLEL_TABS) {
        errors.push(`Parallel tabs exceeds maximum (${SECURITY_LIMITS.MAX_PARALLEL_TABS}) - reduce to prevent browser instability`);
    }

    // ========== GRID SIZE ESTIMATION (CRITICAL SECURITY CHECK) ==========
    if (errors.length === 0) {
        const safeRadius = Math.min(config.radiusKm, SECURITY_LIMITS.MAX_RADIUS_KM);
        const safeSpacing = Math.max(spacingKm, SECURITY_LIMITS.MIN_SPACING_KM);

        // Estimate total grid points using circle approximation
        const estimatedPoints = Math.pow(safeRadius / safeSpacing, 2) * 3.14;
        const estimatedSearches = estimatedPoints * sanitizedKeywords.length;

        console.log(`[SECURITY] Estimated grid size: ~${Math.floor(estimatedPoints)} points, ~${Math.floor(estimatedSearches)} total searches`);

        if (estimatedPoints > SECURITY_LIMITS.MAX_GRID_POINTS) {
            errors.push(
                `Configuration would generate ~${Math.floor(estimatedPoints)} grid points ` +
                `(max ${SECURITY_LIMITS.MAX_GRID_POINTS}). ` +
                `Increase spacing or reduce radius.`
            );
        }

        if (estimatedSearches > SECURITY_LIMITS.MAX_TOTAL_SEARCHES) {
            errors.push(
                `Configuration would generate ~${Math.floor(estimatedSearches)} total searches ` +
                `(max ${SECURITY_LIMITS.MAX_TOTAL_SEARCHES}). ` +
                `Increase spacing, reduce radius, or reduce keywords.`
            );
        }
    }

    // ========== VALIDATION RESULT ==========
    if (errors.length > 0) {
        const errorMessage = '❌ Configuration validation failed:\n' +
            errors.map((e, i) => `   ${i + 1}. ${e}`).join('\n');
        console.error('[SECURITY]', errorMessage);
        throw new Error(errorMessage);
    }

    // Return sanitized configuration with enforced limits
    const validatedConfig = {
        city: config.city.trim(),
        radiusKm: Math.min(config.radiusKm, SECURITY_LIMITS.MAX_RADIUS_KM),
        keywords: sanitizedKeywords,
        spacingKm: Math.max(spacingKm, SECURITY_LIMITS.MIN_SPACING_KM),
        parallelTabs: Math.min(Math.max(1, parallelTabs), SECURITY_LIMITS.MAX_PARALLEL_TABS)
    };

    console.log('[SECURITY] ✅ Configuration validated successfully', validatedConfig);
    return validatedConfig;
}

// =====================================================
// MAIN FUNCTION
// =====================================================

async function startTurboV3(config) {
    if (TURBO_STATE.isRunning) {
        return { status: 'already_running' };
    }

    // CRITICAL: Reset state before starting to prevent memory leaks
    resetTurboState();

    // ===== SECURITY: VALIDATE AND SANITIZE CONFIG =====
    let validatedConfig;
    try {
        validatedConfig = validateAreaSearchConfig(config);
    } catch (error) {
        console.error('[SECURITY] Configuration validation failed:', error.message);
        return {
            status: 'error',
            message: error.message,
            errorType: 'validation_failed'
        };
    }

    // Use validated config exclusively from this point forward
    const { city, radiusKm, keywords, spacingKm, parallelTabs } = validatedConfig;

    console.log('🚀 TURBO v3 - Enhanced Extraction (Security Hardened)');
    console.log(`📍 ${city}, ${radiusKm}km radius`);
    console.log(`🔍 Keywords: ${keywords.join(', ')}`);
    console.log(`⚡ Parallel tabs: ${parallelTabs} (enforced limit: ${SECURITY_LIMITS.MAX_PARALLEL_TABS})`);

    // Get coordinates
    const coords = await getCoords(city);
    if (!coords) {
        return { status: 'error', message: `Location not found: ${city}` };
    }

    // Generate grid
    const points = generateGrid(coords.lat, coords.lon, radiusKm, spacingKm);
    console.log(`📐 ${points.length} grid points`);

    // Generate searches
    const searches = [];
    points.forEach(point => {
        keywords.forEach(keyword => {
            searches.push({
                url: `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${point.lat.toFixed(6)},${point.lon.toFixed(6)},14z`,
                keyword,
                lat: point.lat,
                lon: point.lon
            });
        });
    });

    const totalBatches = Math.ceil(searches.length / parallelTabs);

    // Initialize
    Object.assign(TURBO_STATE, {
        isRunning: true,
        isPaused: false,
        currentBatch: 0,
        totalBatches,
        completedSearches: 0,
        totalSearches: searches.length,
        searches,
        startTime: Date.now(),
        stats: { businessesFound: 0, withWebsite: 0, withPhone: 0 },
        config: { ...TURBO_CONFIG, parallelTabs, centerLat: coords.lat, centerLon: coords.lon, radiusKm }
    });

    console.log(`📦 ${totalBatches} batches, ~${Math.ceil(totalBatches * 15 / 60)} minutes`);

    // Start
    runTurboV3();

    return {
        status: 'started',
        totalSearches: searches.length,
        batches: totalBatches
    };
}

// =====================================================
// SAFE TAB OPERATIONS (SECURITY HARDENED)
// =====================================================

/**
 * Create tabs with timeout, error recovery, and failure tracking
 * SECURITY: Prevents resource exhaustion from stuck tab creations
 * @param {Array} batch - Array of search objects
 * @returns {Promise<Object>} { createdTabs, failedSearches }
 */
async function createTabsWithRecovery(batch) {
    const createdTabs = [];
    const failedSearches = [];

    console.log(`[MULTI-WINDOW] Creating ${batch.length} popup windows with human-like delays`);

    // ANTI-DETECTION: Shuffle batch to break sequential patterns
    const shuffledBatch = HumanBehavior.shuffle(batch);

    // Track circuit breaker wait attempts to prevent infinite loop
    let circuitWaitAttempts = 0;
    const MAX_CIRCUIT_WAIT_ATTEMPTS = 3;

    for (let i = 0; i < shuffledBatch.length; i++) {
        const search = shuffledBatch[i];

        // CIRCUIT BREAKER: Check if we can proceed
        if (!CaptchaDetector.canProceed()) {
            const remaining = CaptchaDetector.getRemainingCooldown();
            circuitWaitAttempts++;

            console.warn(`[CAPTCHA] Circuit open, waiting ${Math.round(remaining / 1000)}s... (attempt ${circuitWaitAttempts}/${MAX_CIRCUIT_WAIT_ATTEMPTS})`);

            // BUG FIX: Prevent silent fail by limiting circuit wait attempts
            if (circuitWaitAttempts >= MAX_CIRCUIT_WAIT_ATTEMPTS) {
                console.error(`[CAPTCHA] Max circuit wait attempts reached. Aborting batch to prevent silent fail.`);
                // B12-1 FIX (2026-05-10): UI listener wired in ui/sidepanel.js
                // (warning toast + Activity Feed entry) and ui/area-search-modal.js
                // (in-modal warning banner with min 8s display time).
                chrome.runtime.sendMessage({
                    action: 'area_search_warning',
                    payload: {
                        message: 'Captcha detection triggered. Pausing to avoid blocking.',
                        cooldownMs: remaining
                    }
                }).catch(() => { });
                break; // Exit loop, don't continue silently
            }

            await sleep(remaining + 1000);
            i--; // Retry this same search after waiting
            continue;
        }

        // Reset circuit wait counter on successful proceed
        circuitWaitAttempts = 0;

        try {
            // HUMANIZATION: Add delay between tab opens (except first)
            if (i > 0) {
                await HumanBehavior.humanDelay(100, 800);
            }

            // Get session with fingerprint for anti-detection
            const session = await sessionPool.getSession();

            // ANTI-DETECTION: Add coordinate jitter to URL
            let jitteredUrl = search.url;
            const coordMatch = search.url.match(/@([\d.-]+),([\d.-]+),/);
            if (coordMatch) {
                const lat = parseFloat(coordMatch[1]);
                const lon = parseFloat(coordMatch[2]);
                const jLat = HumanBehavior.jitterCoordinate(lat, 0.0003);  // FIX: Reduced from 0.0008 to 0.0003 (~33m vs ~88m) to prevent city drift
                const jLon = HumanBehavior.jitterCoordinate(lon, 0.0003);
                jitteredUrl = search.url.replace(
                    /@[\d.-]+,[\d.-]+,/,
                    `@${jLat.toFixed(6)},${jLon.toFixed(6)},`
                );
            }

            // ═══════════════════════════════════════════════════════════════════
            // MULTI-WINDOW PARALLEL SCROLL FIX
            // Creates each tab in its OWN popup window, so each tab is the
            // "active" tab of its window. Chrome does NOT throttle active tabs,
            // so all tabs scroll at full speed in parallel!
            // ═══════════════════════════════════════════════════════════════════
            const windowPromise = chrome.windows.create({
                url: jitteredUrl,
                type: 'popup',           // Popup window - each is the active tab, no throttling!
                width: 600,              // Compact size (was causing full-screen windows)
                height: 400
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error('WINDOW_CREATE_TIMEOUT')),
                    SECURITY_LIMITS.TAB_CREATION_TIMEOUT_MS
                )
            );

            // Race: whichever completes first
            const createdWindow = await Promise.race([windowPromise, timeoutPromise]);

            // Get the tab from the newly created window
            const tab = createdWindow.tabs[0];
            createdTabs.push({
                tab,
                search,
                session,
                windowId: createdWindow.id  // Track window for cleanup
            });

            // BGW-H3 FIX: Register tab for race-safe cleanup
            TURBO_STATE.openTabs.add(tab.id);
            _schedulePersist();  // B3-1: Set mutation doesn't trigger Proxy set; persist explicitly
            // B3-3: Tag this window in chrome.storage.session so stopTurbo
            // fallback can identify it as ours and never close user's own
            // Maps tabs. Fire-and-forget; failure is non-blocking.
            _trackWindow(createdWindow.id).catch(() => { /* logged inside */ });
            // HUMANIZATION: Occasional longer pause (15% chance)
            await HumanBehavior.occasionalPause(0.15, 2000);

        } catch (error) {
            const errorMsg = error.message || 'unknown';
            console.warn(`[TAB] Failed to create tab for "${search.keyword}": ${errorMsg}`);
            failedSearches.push({ search, error: errorMsg });

            // Report failure to CAPTCHA detector
            CaptchaDetector.reportFailure();

            // CRITICAL: If >50% of tabs fail, abort to prevent resource exhaustion
            const failureRate = failedSearches.length / shuffledBatch.length;
            if (failureRate > 0.5 && shuffledBatch.length > 2) {
                console.error(`[SECURITY] Tab creation failure rate: ${Math.round(failureRate * 100)}% - ABORTING BATCH`);

                // Cleanup already created tabs
                await cleanupTabs(createdTabs);

                throw new Error(
                    `Tab creation failed: ${failedSearches.length}/${shuffledBatch.length} failures. ` +
                    `System may be overwhelmed. Try reducing parallel tabs.`
                );
            }

            // If 2+ consecutive failures, reduce speed
            if (CaptchaDetector.consecutiveFailures >= 2) {
                console.warn('[CAPTCHA] Slowing down due to failures...');
                break;
            }
        }
    }

    const successCount = createdTabs.length;
    const failCount = failedSearches.length;
    console.log(`[MULTI-WINDOW] Window creation complete: ${successCount} created, ${failCount} failed`);

    // Report success if we created tabs
    if (successCount > 0) {
        CaptchaDetector.reportSuccess();
    }

    return { createdTabs, failedSearches };
}

/**
 * Cleanup windows/tabs with timeout protection
 * SECURITY: Guaranteed cleanup even if some removals fail
 * MULTI-WINDOW FIX: Now closes popup windows, not just tabs
 * @param {Array} tabs - Array of {tab, search, windowId?} objects
 * @param {number} timeoutMs - Max time to spend on cleanup
 * @returns {Promise<void>}
 */
async function cleanupTabs(tabs, timeoutMs = SECURITY_LIMITS.BATCH_CLEANUP_TIMEOUT_MS) {
    if (!tabs || tabs.length === 0) {
        return;
    }

    console.log(`[SECURITY] Cleaning up ${tabs.length} windows/tabs (timeout: ${timeoutMs}ms)`);
    const startTime = Date.now();

    // MULTI-WINDOW FIX: Close windows if we have windowId, otherwise fallback to tabs
    // B3-3: After successful close, untrack from session-storage ledger so the
    //       stopTurbo emergency fallback doesn't try to re-close it.
    const cleanupPromises = tabs.map(({ tab, windowId }) => {
        if (windowId) {
            // Close the entire popup window
            return chrome.windows.remove(windowId)
                .then(() => _untrackWindow(windowId))
                .catch((/** @type {any} */ err) => {
                    console.warn(`[SECURITY] Failed to close window ${windowId}:`, err?.message || err);
                    // Best-effort untrack even on close failure (window may already be gone)
                    return _untrackWindow(windowId).catch(() => {});
                });
        } else {
            // Fallback: close tab if no window (backwards compatibility)
            return chrome.tabs.remove(tab.id).catch(err => {
                console.warn(`[SECURITY] Failed to close tab ${tab.id}:`, err.message);
            });
        }
    });

    try {
        // Race cleanup against timeout
        await Promise.race([
            Promise.allSettled(cleanupPromises),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('CLEANUP_TIMEOUT')), timeoutMs)
            )
        ]);

        const duration = Date.now() - startTime;
        console.log(`[SECURITY] ✓ Cleanup complete in ${duration}ms`);

    } catch (error) {
        if (error.message === 'CLEANUP_TIMEOUT') {
            console.error(`[SECURITY] ⚠️ Cleanup timed out after ${timeoutMs}ms - some windows may remain open`);
        } else {
            console.error('[SECURITY] Cleanup error:', error.message);
        }
        // Don't throw - cleanup is best-effort
    }
}

// =====================================================
// MAIN LOOP
// =====================================================

// =====================================================
// DEPENDENCY INJECTION
// =====================================================

/**
 * Save handler function (dependency injection)
 * Set from background script to avoid message passing
 */
let saveHandler = null;

/**
 * Set the save handler function (dependency injection)
 * Allows direct calling from background script without messaging
 * @param {Function} handler - Function to handle batch saving
 */
function setSaveHandler(handler) {
    saveHandler = handler;
    console.log('[AreaSearch] Save handler registered');
}

/**
 * Save batch of businesses to database with message queue overflow protection
 * SECURITY: Validates message size, splits large batches, throttles message rate
 * @param {Array} businesses - Array of business objects
 * @returns {Promise<{saved: number, duplicates: number, errors: number}>}
 */
async function saveBatch(businesses) {
    if (!businesses || businesses.length === 0) {
        return { saved: 0, duplicates: 0, errors: 0 };
    }

    try {
        // OPTION 1: Direct Handler (Preferred - No Messages)
        if (saveHandler) {
            const response = await saveHandler(businesses);
            console.log(`[BATCH SAVE DIRECT] ✓ ${response.saved} saved, ${response.duplicates} duplicates, ${response.errors} errors`);
            return response;
        }

        // OPTION 2: Message Passing with SECURITY HARDENING
        return await saveBatchViaMessages(businesses);

    } catch (error) {
        console.error('[BATCH SAVE ERROR]', error.message);
        return { saved: 0, duplicates: 0, errors: businesses.length };
    }
}

/**
 * Save businesses via message passing with security protections
 * SECURITY: Prevents message queue overflow via size validation and batch splitting
 * @private
 * @param {Array} businesses - Array of business objects
 * @returns {Promise<{saved: number, duplicates: number, errors: number}>}
 */
async function saveBatchViaMessages(businesses) {
    const results = { saved: 0, duplicates: 0, errors: 0 };

    // SECURITY: Split into safe message-sized batches
    const batches = splitIntoSafeBatches(businesses);

    console.log(`[SECURITY] Splitting ${businesses.length} businesses into ${batches.length} safe message batches`);

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        try {
            // Validate message size before sending
            const messageSize = estimateMessageSize(batch);

            if (messageSize > MESSAGE_LIMITS.MAX_MESSAGE_SIZE_BYTES) {
                // Should never happen if splitIntoSafeBatches() works correctly
                console.error(`[SECURITY] Message too large: ${messageSize} bytes (max: ${MESSAGE_LIMITS.MAX_MESSAGE_SIZE_BYTES})`);
                results.errors += batch.length;
                continue;
            }

            // Send message
            const response = await chrome.runtime.sendMessage({
                action: 'save_business_batch',
                payload: { businesses: batch }
            });

            // Handle response
            if (!response) {
                console.error('[BATCH SAVE ERROR] No response received');
                results.errors += batch.length;
            } else if (response.error) {
                console.error('[BATCH SAVE ERROR]', response.error);
                results.errors += batch.length;
            } else {
                results.saved += response.saved || 0;
                results.duplicates += response.duplicates || 0;
                results.errors += response.errors || 0;
            }

        } catch (error) {
            console.error('[BATCH SAVE ERROR]', error.message);
            results.errors += batch.length;
        }

        // SECURITY: Throttle messages to prevent queue overflow
        if (i < batches.length - 1) {
            await sleep(MESSAGE_LIMITS.MESSAGE_THROTTLE_MS);
        }
    }

    console.log(`[BATCH SAVE] ✓ ${results.saved} saved, ${results.duplicates} dup, ${results.errors} err (from ${businesses.length} total)`);
    return results;
}

/**
 * Split businesses into safe message-sized batches
 * SECURITY: Ensures each batch is under MESSAGE_LIMITS.MAX_MESSAGE_SIZE_BYTES
 * @private
 * @param {Array} businesses - Array of business objects
 * @returns {Array<Array>} Array of batches
 */
function splitIntoSafeBatches(businesses) {
    const batches = [];
    let currentBatch = [];
    let currentSize = 0;

    for (const business of businesses) {
        const businessSize = estimateBusinessSize(business);
        const potentialSize = currentSize + businessSize;

        // Check if adding this business would exceed limit OR max batch size
        if (currentBatch.length > 0 &&
            (potentialSize > MESSAGE_LIMITS.MAX_MESSAGE_SIZE_BYTES ||
                currentBatch.length >= MESSAGE_LIMITS.MAX_BATCH_SIZE)) {
            // Start new batch
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }

        currentBatch.push(business);
        currentSize += businessSize;
    }

    // Add final batch
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches.length > 0 ? batches : [[]];
}

/**
 * Estimate size of a single business object in bytes
 * SECURITY: Conservative estimation with overhead multiplier
 * @private
 * @param {Object} business - Business object
 * @returns {number} Estimated size in bytes
 */
function estimateBusinessSize(business) {
    // JSON.stringify is expensive, use approximation
    // Average business: ~500-1000 bytes
    const baseSize = 800;

    // Add size for optional large fields
    let extraSize = 0;
    if (business.website) extraSize += business.website.length * 2;
    if (business.email) extraSize += business.email.length * 2;
    if (business.address) extraSize += business.address.length * 2;
    if (business.title) extraSize += business.title.length * 2;

    return (baseSize + extraSize) * MESSAGE_LIMITS.SIZE_ESTIMATE_OVERHEAD;
}

/**
 * Estimate total message size for a batch
 * SECURITY: Accurate size check before sending
 * @private
 * @param {Array} batch - Array of business objects
 * @returns {number} Estimated size in bytes
 */
function estimateMessageSize(batch) {
    try {
        // Accurate measurement via JSON.stringify
        const payload = { action: 'save_business_batch', payload: { businesses: batch } };
        return JSON.stringify(payload).length;
    } catch (error) {
        // Fallback to conservative estimate
        return batch.reduce((sum, biz) => sum + estimateBusinessSize(biz), 0);
    }
}

// =====================================================
// v9.11 — DETAIL-FETCH MIRROR (Area Search ↔ manual mode)
// =====================================================
//
// In v9.10 manual mode, the user clicks "Start Monitoring" → observer.start
// → DOM mutations during scroll → business_found + auto-fire detail-fetch
// → ≥99% phone coverage. In Area Search the manifest already injects
// observer + detail-fetcher into every popup tab (matches /maps/*) but
// observer never starts (no `start_scraping` message) and the tab is
// closed before any in-flight /maps/preview/place fetches can complete.
//
// These helpers bridge the gap. They depend ONLY on:
//   - chrome.tabs.sendMessage  → wakes observer in ISOLATED world
//   - chrome.scripting.executeScript({ world: 'MAIN' })
//                              → reads __ghostMapDetailFetcherStats
//                              → exposed by content/gmb/detail-fetcher.js
//
// Both helpers are no-throw and degrade gracefully:
//   - chrome.tabs.sendMessage failure on a single tab → that tab is
//     covered only by extractEnhanced (current path, no regression)
//   - __ghostMapDetailFetcherStats undefined → treat as idle (e.g.
//     feature flag off, page not yet mounted, content script error)

/**
 * Wake the manual-mode observer in each Area Search popup tab.
 * Sends `start_scraping`. Retries 3× with 200ms backoff to cover the
 * window where content_scripts at document_idle haven't finished
 * loading lib/observer.js yet.
 *
 * Fire-and-forget per tab — a failure leaves that tab on the legacy
 * extractEnhanced-only path. Returns the count of tabs that ack'd.
 *
 * @param {Array<{tab: {id: number}}>} tabs
 * @returns {Promise<{woken: number, failed: number}>}
 */
async function _wakeObserversInTabs(tabs) {
    let woken = 0;
    let failed = 0;
    await Promise.allSettled(tabs.map(async ({ tab }) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const r = await chrome.tabs.sendMessage(tab.id, { action: 'start_scraping' });
                if (r && (r.status === 'started' || r.status === 'already_running')) {
                    woken++;
                    return;
                }
            } catch (e) {
                if (attempt < 3) {
                    await sleep(200);
                    continue;
                }
            }
        }
        failed++;
    }));
    return { woken, failed };
}

/**
 * Snapshot the detail-fetcher MAIN-world stats in each tab. Used twice:
 *   - inside the drain poll loop, to decide whether to keep waiting
 *   - after the loop, to log the post-drain summary
 *
 * Returns an array aligned with `tabs` — entries may have `idle:true`
 * with no other fields if the fetcher isn't installed (manifest mismatch
 * or page error). Errors per-tab don't propagate.
 *
 * @param {Array<{tab: {id: number}}>} tabs
 * @returns {Promise<Array<{tabId: number, idle: boolean, inflight?: number, queued?: number, requested?: number, succeeded?: number, killSwitch?: boolean}>>}
 */
async function _collectDetailFetcherStats(tabs) {
    const out = [];
    for (const { tab } of tabs) {
        try {
            const [r] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: () => {
                    if (typeof window.__ghostMapDetailFetcherStats !== 'function') {
                        return { idle: true, missing: true };
                    }
                    const s = window.__ghostMapDetailFetcherStats();
                    return {
                        idle: (s.inflight || 0) === 0 && (s.queued || 0) === 0,
                        inflight: s.inflight || 0,
                        queued: s.queued || 0,
                        requested: s.requested || 0,
                        succeeded: s.succeeded || 0,
                        failed: s.failed || 0,
                        killSwitch: !!s.killSwitch
                    };
                }
            });
            out.push({ tabId: tab.id, ...(r?.result || { idle: true }) });
        } catch (e) {
            // F-02: tab closed / scripting failed is NOT idle. Honest "we
            //       don't know" signal: dead:true keeps the loop from
            //       hanging (terminal state) but flips drainedFully to
            //       false so the caller logs the truth instead of
            //       pretending success.
            out.push({ tabId: tab.id, idle: false, dead: true, error: e?.message });
        }
    }
    return out;
}

/**
 * Block until every tab's detail-fetcher reaches a TERMINAL state — either
 * cleanly idle (inflight=queued=0) or dead (chrome.scripting threw). Polls
 * every 500ms. Returns the elapsed time + final stats.
 *
 * F-02: distinguishes clean drain from degraded exit. drainedFully is true
 * only when zero tabs died during drain. deadTabs / lostInflight let the
 * caller log the postmortem honestly. lastKnown captures the last live
 * stats per tab so we can report what was inflight at the moment of death.
 *
 * @param {Array<{tab: {id: number}}>} tabs
 * @param {number} timeoutMs
 * @param {number} [pollMs=500]
 * @returns {Promise<{drainedFully: boolean, elapsedMs: number, stats: Array, deadTabs: number, lostInflight: number}>}
 */
async function _waitForDetailFetcherIdle(tabs, timeoutMs, pollMs = 500) {
    const start = Date.now();
    const lastKnown = new Map();  // tabId → last live stats (pre-death snapshot)
    while (Date.now() - start < timeoutMs) {
        const stats = await _collectDetailFetcherStats(tabs);
        for (const s of stats) {
            if (!s.dead) lastKnown.set(s.tabId, s);
        }
        // F-02: exit when every tab is terminal (idle OR dead). drainedFully
        // is true only if no tab died — otherwise caller knows it was a
        // degraded drain.
        const allTerminal = stats.every(s => s.idle || s.dead);
        if (allTerminal) {
            const deadTabs = stats.filter(s => s.dead).length;
            const lostInflight = stats
                .filter(s => s.dead)
                .reduce((sum, s) => sum + (lastKnown.get(s.tabId)?.inflight || 0), 0);
            return {
                drainedFully: deadTabs === 0,
                elapsedMs: Date.now() - start,
                stats,
                deadTabs,
                lostInflight
            };
        }
        await sleep(pollMs);
    }
    const finalStats = await _collectDetailFetcherStats(tabs);
    for (const s of finalStats) {
        if (!s.dead) lastKnown.set(s.tabId, s);
    }
    const deadTabs = finalStats.filter(s => s.dead).length;
    const lostInflight = finalStats
        .filter(s => s.dead)
        .reduce((sum, s) => sum + (lastKnown.get(s.tabId)?.inflight || 0), 0);
    return {
        drainedFully: false,
        elapsedMs: Date.now() - start,
        stats: finalStats,
        deadTabs,
        lostInflight
    };
}

/**
 * Apply per-batch stats to global TURBO_STATE.
 *
 * H-02: businessesFound counts UNIQUE-SAVED, not raw DOM-extracted, so the
 * Area Search toast doesn't inflate by duplicates. duplicatesFound is the
 * sibling counter for observability.
 *
 * Spec & regression test: tests/run-h02-stats-apply-node.mjs (LAST-SYNCED 2026-05-08).
 */
function _applyBatchStatsToTurbo(stats, batch) {
    stats.businessesFound += batch.saved;
    stats.duplicatesFound = (stats.duplicatesFound || 0) + (batch.duplicates || 0);
    stats.withWebsite     += batch.websites;
    stats.withPhone       += batch.phones;
    // SAVE-DLQ (2026-05-28): failedSaveEvents is a per-run FAILURE-EVENT counter
    // (diagnostic). Unlike withPhone/withWebsite it is NOT an attribute that can
    // over-count per grid-cell — it counts save-attempt failures. The authoritative
    // "still lost" number is the live DLQ depth read at finishTurbo (pendingInQueue).
    stats.failedSaveEvents = (stats.failedSaveEvents || 0) + (batch.errors || 0);
    stats.quotaFailures    = (stats.quotaFailures || 0) + (batch.quotaFailures || 0);
    stats.dlqDropped       = (stats.dlqDropped || 0) + (batch.dlqDropped || 0);
}

/**
 * Record the outcome of an observer-wake batch (F-01b).
 *
 * Increments tabsFailedWake counter and broadcasts a high-fail-rate warning
 * when more than 30% of tabs failed to ack start_scraping — a signal that
 * those tabs will fall back to legacy DOM-only extraction without enrichment,
 * silently degrading record quality (1–5% of records per docs §F-01b).
 *
 * Broadcast pattern matches the existing area_search_warning channel at
 * ~line 593 (CAPTCHA circuit-open warning); fire-and-forget with .catch.
 *
 * Spec & regression test: tests/run-f01b-wake-outcome-node.mjs (LAST-SYNCED 2026-05-08).
 */
function _recordWakeOutcome(stats, woken, failedCount, totalTabs) {
    if (!stats.detailFetch) {
        stats.detailFetch = { requested: 0, succeeded: 0, killSwitchTrips: 0, drainTimeouts: 0, tabsDiedDuringDrain: 0, tabsFailedWake: 0 };
    }
    stats.detailFetch.tabsFailedWake = (stats.detailFetch.tabsFailedWake || 0) + failedCount;
    if (totalTabs <= 0) return;  // defensive: no division by zero
    const failRate = failedCount / totalTabs;
    if (failRate > 0.30) {
        console.warn(`[area-search] HIGH WAKE FAIL RATE: ${failedCount}/${totalTabs} tabs failed observer wake (${Math.round(failRate * 100)}%). Those tabs will fall back to legacy DOM-only extraction.`);
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({
                action: 'area_search_warning',
                payload: {
                    type: 'high_wake_fail_rate',
                    rate: failRate,
                    failed: failedCount,
                    total: totalTabs
                }
            }).catch(() => { });
        }
    }
}

async function runTurboV3() {
    // F-03: install lifecycle sentinel BEFORE any await so stopTurbo can
    //       always observe it.
    _runLoopSentinel = _makeRunLoopSentinel();
    try {
    const { parallelTabs, pageLoadWait, scrollDuration, extractionWait, batchDelay } = TURBO_STATE.config;

    // Initialize batch error tracking (SECURITY: abort after consecutive failures)
    // B3-1: nested write requires top-level replacement to trigger Proxy persist.
    if (!TURBO_STATE.stats.batchErrors) {
        TURBO_STATE.stats = { ...TURBO_STATE.stats, batchErrors: 0 };
    }

    while (TURBO_STATE.isRunning && TURBO_STATE.currentBatch < TURBO_STATE.totalBatches) {
        if (TURBO_STATE.isPaused) {
            await sleep(500);
            continue;
        }

        const batchStart = TURBO_STATE.currentBatch * parallelTabs;
        const batchEnd = Math.min(batchStart + parallelTabs, TURBO_STATE.totalSearches);
        const batch = TURBO_STATE.searches.slice(batchStart, batchEnd);

        console.log(`\n📦 Batch ${TURBO_STATE.currentBatch + 1}/${TURBO_STATE.totalBatches}`);

        let createdTabs = [];  // Track tabs for guaranteed cleanup

        try {
            // ===== 1. SAFE TAB CREATION WITH RECOVERY =====
            const { createdTabs: tabs, failedSearches } = await createTabsWithRecovery(batch);
            createdTabs = tabs;

            if (failedSearches.length > 0) {
                console.warn(`[SECURITY] ${failedSearches.length}/${batch.length} tabs failed to create`);
            }

            if (createdTabs.length === 0) {
                throw new Error('All tab creations failed for this batch');
            }

            console.log(`  ✓ Created ${createdTabs.length}/${batch.length} tabs successfully`);

            // ===== 2. WAIT FOR PAGE LOAD =====
            console.log(`  ⏳ Waiting ${pageLoadWait}ms for page load...`);
            await sleep(pageLoadWait);

            // ===== 2b. v9.11 WAKE MANUAL-MODE OBSERVER IN EACH TAB =====
            // Sends `start_scraping` so DOMObserver in ISOLATED world
            // attaches BEFORE injectHumanScroll fires the scroll events.
            // MutationObserver must be already listening or it misses
            // virtual-list mounts that flash in/out during fast scroll.
            // Fire-and-forget; tabs that fail still get extractEnhanced.
            if (CONFIG.areaSearch && CONFIG.areaSearch.useDetailFetch) {
                const wakeStart = Date.now();
                const { woken, failed } = await _wakeObserversInTabs(createdTabs);
                console.log(`  🔔 Observer wake: ${woken} ack / ${failed} fail (${Date.now() - wakeStart}ms)`);
                // F-01b: surface tabs that failed to wake so the dashboard
                //        can spot silent-degradation outbreaks (1–5% record loss).
                // B3-1: _recordWakeOutcome mutates the stats object passed by
                //       reference; the Proxy doesn't intercept nested writes,
                //       so we clone-mutate-replace to trigger persistence.
                const _statsClone = { ...TURBO_STATE.stats };
                if (_statsClone.detailFetch) _statsClone.detailFetch = { ..._statsClone.detailFetch };
                _recordWakeOutcome(_statsClone, woken, failed, createdTabs.length);
                TURBO_STATE.stats = _statsClone;
            }

            // ===== 3. SCROLL ALL TABS =====
            console.log(`  📜 Scrolling ${createdTabs.length} tabs...`);
            await Promise.allSettled(createdTabs.map(({ tab }) => injectHumanScroll(tab.id)));

            // ===== 4. WAIT FOR SCROLL COMPLETION (ENHANCED: Poll for actual completion) =====
            console.log(`  ⏳ Waiting for scroll completion (polling every 2s, max 180s)...`);
            const scrollMaxWait = 180000;  // 180 seconds max (3 minutes for deep scroll)
            const pollInterval = 2000;     // Check every 2 seconds
            let scrollElapsed = 0;

            while (scrollElapsed < scrollMaxWait) {
                await sleep(pollInterval);
                scrollElapsed += pollInterval;

                // Check if ALL tabs have completed scrolling
                let allComplete = true;
                let completedCount = 0;

                for (const { tab } of createdTabs) {
                    try {
                        const [result] = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: () => ({
                                complete: window.__GHOST_SCROLL_COMPLETE__ === true,
                                count: window.__GHOST_SCROLL_COUNT__ || 0,
                                debug: window.__GHOST_SCROLL_DEBUG__ || null
                            })
                        });

                        if (result?.result?.complete) {
                            completedCount++;
                        } else {
                            allComplete = false;
                            // Log debug info for incomplete tabs
                            if (result?.result?.debug) {
                                const d = result.result.debug;
                                // Support both old format (sameCount/threshold) and new NSA format (state/signals)
                                if (d.state) {
                                    // NSA scroll format
                                    const activeSignals = d.signals ? Object.values(d.signals).filter(Boolean).length : 0;
                                    console.log(`    [TAB ${tab.id}] #${d.scrollCount} | Height: ${d.height}px | State: ${d.state} | Signals: ${activeSignals}/5`);
                                } else {
                                    // Old format fallback
                                    console.log(`    [TAB ${tab.id}] #${d.scrollCount} | Height: ${d.height}px | Same: ${d.sameCount}/${d.threshold}`);
                                }
                            }
                        }
                    } catch (e) {
                        // Tab might have been closed or error - consider it complete
                        completedCount++;
                    }
                }

                if (allComplete) {
                    console.log(`  ✓ All ${createdTabs.length} tabs completed scrolling in ${scrollElapsed}ms`);
                    break;
                }

                // Log progress every 10 seconds
                if (scrollElapsed % 10000 === 0) {
                    console.log(`  ⏳ Scroll progress: ${completedCount}/${createdTabs.length} tabs complete (${scrollElapsed / 1000}s elapsed)`);
                }
            }

            if (scrollElapsed >= scrollMaxWait) {
                console.warn(`  ⚠️ Scroll timeout after ${scrollMaxWait / 1000}s - proceeding with extraction`);
            }

            // ===== 5. EXTRACT AND SAVE BUSINESSES =====
            console.log(`  🔍 Extracting businesses from ${createdTabs.length} tabs...`);
            let batchStats = { found: 0, websites: 0, phones: 0, saved: 0, duplicates: 0, errors: 0, quotaFailures: 0, dlqDropped: 0 };
            let businessBatch = [];
            // BUG-008 FIX: Use MESSAGE_LIMITS.MAX_BATCH_SIZE instead of hardcoded 20
            const BATCH_SIZE = MESSAGE_LIMITS.MAX_BATCH_SIZE;

            // Search center + radius (stamped per business so the CSV export can
            // compute distance-from-center). Read once per batch — TURBO_STATE is
            // a Proxy, so avoid a per-business get.
            const _runCfg = TURBO_STATE.config || {};

            for (const { tab, search } of createdTabs) {
                try {
                    const businesses = await extractEnhanced(tab.id);

                    for (const biz of businesses) {
                        // Add search context
                        biz.searchKeyword = search.keyword;
                        biz.searchLocation = `${search.lat.toFixed(4)}, ${search.lon.toFixed(4)}`;
                        if (typeof _runCfg.centerLat === 'number') biz.searchCenterLat = _runCfg.centerLat;
                        if (typeof _runCfg.centerLon === 'number') biz.searchCenterLon = _runCfg.centerLon;
                        if (typeof _runCfg.radiusKm === 'number') biz.searchRadiusKm = _runCfg.radiusKm;

                        businessBatch.push(biz);

                        batchStats.found++;
                        if (biz.website) batchStats.websites++;
                        if (biz.phone) batchStats.phones++;

                        // Batch save to prevent memory issues
                        if (businessBatch.length >= BATCH_SIZE) {
                            const saveResult = await saveBatch(businessBatch);
                            batchStats.saved += saveResult.saved || 0;
                            batchStats.duplicates += saveResult.duplicates || 0;
                            // SAVE-DLQ (2026-05-28): no longer discard the failure count.
                            batchStats.errors += saveResult.errors || 0;
                            batchStats.quotaFailures += saveResult.quotaFailures || 0;
                            batchStats.dlqDropped += saveResult.dlqDropped || 0;
                            businessBatch = [];
                            await sleep(100);
                        }
                    }
                } catch (e) {
                    console.error(`[EXTRACTION ERROR] Tab ${tab.id}:`, e.message);
                }
            }

            // Save remaining businesses
            if (businessBatch.length > 0) {
                console.log(`  💾 Saving final batch of ${businessBatch.length} businesses...`);
                const saveResult = await saveBatch(businessBatch);
                batchStats.saved += saveResult.saved || 0;
                batchStats.duplicates += saveResult.duplicates || 0;
                batchStats.errors += saveResult.errors || 0;
                batchStats.quotaFailures += saveResult.quotaFailures || 0;
                batchStats.dlqDropped += saveResult.dlqDropped || 0;
            }

            // Update global stats — H-02: count unique-saved, not DOM-extracted
            // B3-1: clone-mutate-replace pattern so the Proxy set trap fires
            // and persists to chrome.storage.session.
            const _statsAfterBatch = { ...TURBO_STATE.stats };
            _applyBatchStatsToTurbo(_statsAfterBatch, batchStats);
            _statsAfterBatch.batchErrors = 0;  // Reset error counter on success
            TURBO_STATE.stats = _statsAfterBatch;

            console.log(`  📊 Results: ${batchStats.found} businesses | ${batchStats.websites} websites | ${batchStats.phones} phones`);

            // =====================================================
            // EARLY TERMINATION OPTIMIZATION
            // =====================================================
            // Track consecutive low-yield batches
            const newBusinesses = batchStats.saved;
            const duplicateRate = batchStats.duplicates / Math.max(1, batchStats.saved + batchStats.duplicates);

            if (newBusinesses < GRID_OPTIMIZER.LOW_YIELD_THRESHOLD) {
                TURBO_STATE.consecutiveLowYield++;
                console.log(`[OPTIMIZER] Low yield batch (${newBusinesses} new). Consecutive: ${TURBO_STATE.consecutiveLowYield}/${GRID_OPTIMIZER.MAX_CONSECUTIVE_LOW_YIELD}`);
            } else {
                TURBO_STATE.consecutiveLowYield = 0;
            }

            // Early termination when area is saturated
            if (TURBO_STATE.consecutiveLowYield >= GRID_OPTIMIZER.MAX_CONSECUTIVE_LOW_YIELD) {
                console.log('[OPTIMIZER] 🏁 Early termination: Area saturated');
                TURBO_STATE.isRunning = false;
            }

        } catch (error) {
            // SECURITY: Track and abort on consecutive failures
            // B3-1: replacement pattern triggers Proxy persist
            const _newBatchErrors = (TURBO_STATE.stats.batchErrors || 0) + 1;
            TURBO_STATE.stats = { ...TURBO_STATE.stats, batchErrors: _newBatchErrors };
            console.error(`[BATCH ERROR] Batch ${TURBO_STATE.currentBatch + 1} failed:`, error.message);
            console.error(`[SECURITY] Consecutive batch errors: ${_newBatchErrors}/${SECURITY_LIMITS.MAX_CONSECUTIVE_BATCH_ERRORS}`);

            // Abort if too many consecutive failures
            if (_newBatchErrors >= SECURITY_LIMITS.MAX_CONSECUTIVE_BATCH_ERRORS) {
                console.error(`[SECURITY] ⛔ Aborting area search: ${SECURITY_LIMITS.MAX_CONSECUTIVE_BATCH_ERRORS} consecutive batch failures`);
                TURBO_STATE.isRunning = false;
                // BUG-002 FIX: Reset state to prevent memory leak on abort
                resetTurboState();
                break;  // Exit while loop
            }

        } finally {
            // F-03: snapshot the runtime flag at finally entry. If stopTurbo
            //       arrived while the batch was running, isRunning is false
            //       NOW and resetTurboState is about to fire. Skip writes
            //       that would go to the half-torn-down state.
            const isStillRunning = TURBO_STATE.isRunning;

            // ===== v9.11 DRAIN DETAIL-FETCHER BEFORE CLOSING TABS =====
            // Wait for in-flight /maps/preview/place fetches to land their
            // `business_enrichment` messages at the SW. Without this, the
            // popup window close (in cleanupTabs) aborts pending fetches
            // mid-flight and the enrichment payload is lost — exactly the
            // gap that kept Area Search at ~22% phone coverage in v9.10.
            //
            // Hard timeout from CONFIG.areaSearch.drainTimeoutMs (default 15s).
            // Sized for ~30 cards/tab × 500ms latency / 3 concurrency.
            // Stats logged on every batch — used to right-size the timeout
            // post-deploy.
            if (CONFIG.areaSearch && CONFIG.areaSearch.useDetailFetch && createdTabs.length > 0) {
                const drainTimeout = CONFIG.areaSearch.drainTimeoutMs || 15_000;
                const drainResult = await _waitForDetailFetcherIdle(createdTabs, drainTimeout);
                const totRequested = drainResult.stats.reduce((a, s) => a + (s.requested || 0), 0);
                const totSucceeded = drainResult.stats.reduce((a, s) => a + (s.succeeded || 0), 0);
                const totInflight = drainResult.stats.reduce((a, s) => a + (s.inflight || 0), 0);
                const totQueued = drainResult.stats.reduce((a, s) => a + (s.queued || 0), 0);
                const trippedTabs = drainResult.stats.filter(s => s.killSwitch).length;
                const deadTabs = drainResult.deadTabs || 0;
                const lostInflight = drainResult.lostInflight || 0;
                if (drainResult.drainedFully) {
                    console.log(`  ✓ detail-fetcher drained: ${totSucceeded}/${totRequested} succeeded across ${createdTabs.length} tabs in ${drainResult.elapsedMs}ms (kill-switch: ${trippedTabs})`);
                } else if (deadTabs > 0) {
                    // F-02: degraded drain — tab(s) died mid-flight. Distinct
                    //       from a real timeout; report it as such instead of
                    //       pretending it was clean.
                    console.warn(`  ⚠️  detail-fetcher drain DEGRADED after ${drainResult.elapsedMs}ms: ${deadTabs} tab(s) died mid-drain (~${lostInflight} inflight lost), ${totSucceeded}/${totRequested} succeeded, ${totInflight} inflight + ${totQueued} queued aborted by tab close (kill-switch: ${trippedTabs})`);
                } else {
                    console.warn(`  ⚠️  detail-fetcher drain TIMEOUT after ${drainResult.elapsedMs}ms: ${totSucceeded}/${totRequested} succeeded, ${totInflight} inflight + ${totQueued} queued aborted by tab close (kill-switch: ${trippedTabs})`);
                }
                // Update aggregate stats so the UI/sidepanel can show how
                // many of the cumulative phones came from detail-fetch.
                // F-03: only mutate global stats if isRunning still true at
                //       finally entry. resetTurboState may be racing this.
                // B3-1: batch ALL detailFetch mutations into a single
                //       replacement-style write so the Proxy set trap fires
                //       once and persists the new state to chrome.storage.session.
                if (isStillRunning) {
                    const _detailFetchPrev = TURBO_STATE.stats.detailFetch || {
                        requested: 0, succeeded: 0, killSwitchTrips: 0,
                        drainTimeouts: 0, tabsDiedDuringDrain: 0, tabsFailedWake: 0
                    };
                    const _detailFetchNext = {
                        ..._detailFetchPrev,
                        requested:        (_detailFetchPrev.requested || 0)        + totRequested,
                        succeeded:        (_detailFetchPrev.succeeded || 0)        + totSucceeded,
                        killSwitchTrips:  (_detailFetchPrev.killSwitchTrips || 0)  + trippedTabs
                    };
                    // F-02: separate counters for the two failure modes so the
                    //       dashboard can tell "tabs are dying" from "drain too
                    //       short" — they call for different fixes.
                    if (deadTabs > 0) {
                        _detailFetchNext.tabsDiedDuringDrain = (_detailFetchPrev.tabsDiedDuringDrain || 0) + deadTabs;
                    } else if (!drainResult.drainedFully) {
                        _detailFetchNext.drainTimeouts = (_detailFetchPrev.drainTimeouts || 0) + 1;
                    }
                    TURBO_STATE.stats = { ...TURBO_STATE.stats, detailFetch: _detailFetchNext };
                }
            }

            // ===== GUARANTEED CLEANUP (CRITICAL SECURITY) =====
            // This ALWAYS runs, even if there were errors.
            // F-03: serialize per-batch cleanup with stopTurbo's mutex-
            //       protected cleanup to prevent double-close races on tab
            //       IDs ("No tab with id" warnings).
            await tabCleanupMutex.runExclusive(async () => {
                await cleanupTabs(createdTabs);
            });

            // Update progress — F-03: skip if stopTurbo arrived during the
            // batch, otherwise resetTurboState is about to wipe these.
            if (isStillRunning) {
                TURBO_STATE.completedSearches += batch.length;
                TURBO_STATE.currentBatch++;
            }

            // H-002 FIX: Progressive memory cleanup to prevent unbounded growth
            // Clear processed searches every 5 batches to free memory during long sessions
            // This prevents the searches array from consuming excessive memory
            if (TURBO_STATE.currentBatch % 5 === 0 && TURBO_STATE.currentBatch > 0) {
                const processedCount = TURBO_STATE.currentBatch * parallelTabs;
                if (processedCount < TURBO_STATE.searches.length) {
                    // Only keep remaining searches, clear processed ones
                    TURBO_STATE.searches = TURBO_STATE.searches.slice(processedCount);
                    TURBO_STATE.currentBatch = 0;  // Reset batch counter
                    TURBO_STATE.totalBatches = Math.ceil(TURBO_STATE.searches.length / parallelTabs);
                    console.log(`[MEMORY] 🧹 Cleared processed searches, ${TURBO_STATE.searches.length} remaining`);
                }
            }

            broadcastProgress();

            // Delay between batches
            if (TURBO_STATE.isRunning && TURBO_STATE.currentBatch < TURBO_STATE.totalBatches) {
                console.log(`  ⏸️  Waiting ${batchDelay}ms before next batch...`);
                await sleep(batchDelay);
            }
        }
    }

    // OBS-4 (2026-05-17): finishTurbo is now async (DB-truth reconciliation
    // + final broadcast + race-fix sleep). Await so the run-loop sentinel
    // signals AFTER the completion message has dispatched, preserving the
    // happens-before relationship stopTurbo callers rely on.
    await finishTurbo();
    } finally {
        // F-03: signal sentinel so stopTurbo (if awaiting) can proceed past
        //       its await and tear down state cleanly. Single-shot.
        _runLoopSentinel?.signal();
        _runLoopSentinel = null;
    }
}

// =====================================================
// ENHANCED EXTRACTION - Handles Hotels!
// =====================================================

async function extractEnhanced(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                // ========== HELPER FUNCTIONS ==========

                function looksLikeDomain(str) {
                    if (!str || str.length < 4 || !str.includes('.')) return false;
                    str = str.toLowerCase().trim()
                        .replace(/^https?:\/\//, '')
                        .replace(/^www\./, '')
                        .split('/')[0];  // Remove path

                    const parts = str.split('.');
                    if (parts.length < 2) return false;

                    // B5-6 fix: TLD upper bound 6 → 24 to cover modern ICANN
                    // TLDs (.museum, .versicherung, .construction, …).
                    const tld = parts[parts.length - 1];
                    if (tld.length < 2 || tld.length > 24 || !/^[a-z]+$/.test(tld)) return false;

                    const domain = parts[parts.length - 2];
                    if (domain.length < 1) return false;

                    return true;
                }

                function isExcludedDomain(d) {
                    const excluded = [
                        'google.', 'goo.gl', 'maps.',
                        'facebook.', 'fb.com', 'instagram.', 'twitter.', 'x.com',
                        'youtube.', 'linkedin.', 'tiktok.',
                        'booking.com', 'tripadvisor.', 'expedia.', 'hotels.com',
                        'airbnb.', 'yelp.', 'paginegialle.',
                        'apple.com', 'play.google'
                    ];
                    return excluded.some(ex => d.toLowerCase().includes(ex));
                }

                function extractWebsite(container, fullText) {
                    // === STRATEGY 1: Direct <a> links ===
                    const links = container.querySelectorAll('a[href^="http"]');
                    for (const a of links) {
                        const href = a.href || '';
                        if (href && !isExcludedDomain(href)) {
                            return href;
                        }
                    }

                    // === STRATEGY 2: Text that looks like domain ===
                    // This handles "galzignano.it" style hotel listings
                    const domainPatterns = [
                        // Specific Italian TLDs
                        /\b([a-z0-9][-a-z0-9]{0,62}\.it)\b/gi,
                        /\b([a-z0-9][-a-z0-9]{0,62}\.com)\b/gi,
                        /\b([a-z0-9][-a-z0-9]{0,62}\.eu)\b/gi,
                        /\b([a-z0-9][-a-z0-9]{0,62}\.net)\b/gi,
                        /\b([a-z0-9][-a-z0-9]{0,62}\.org)\b/gi,
                        // With www
                        /\b(www\.[a-z0-9][-a-z0-9]{0,62}\.[a-z]{2,6})\b/gi,
                        // Generic
                        /\b([a-z0-9][-a-z0-9]{0,62}\.[a-z]{2,6})\b/gi
                    ];

                    for (const pattern of domainPatterns) {
                        pattern.lastIndex = 0;  // Reset regex
                        const matches = fullText.match(pattern);
                        if (matches) {
                            for (const match of matches) {
                                if (looksLikeDomain(match) && !isExcludedDomain(match)) {
                                    const clean = match.toLowerCase().replace(/^www\./, '');
                                    return 'https://' + clean;
                                }
                            }
                        }
                    }

                    // === STRATEGY 3: Data attributes ===
                    const dataEls = container.querySelectorAll('[data-value], [data-url]');
                    for (const el of dataEls) {
                        const val = el.getAttribute('data-value') || el.getAttribute('data-url') || '';
                        if (val && looksLikeDomain(val) && !isExcludedDomain(val)) {
                            return val.startsWith('http') ? val : 'https://' + val;
                        }
                    }

                    return null;
                }

                // ═══════════════════════════════════════════════════════════════
                // INLINE normalizePhone - PAGE CONTEXT REQUIRED (CANNOT IMPORT)
                // ═══════════════════════════════════════════════════════════════
                // ⚠️ BGW-C1 ARCHITECTURAL NOTE:
                // This function is INTENTIONALLY duplicated from lib/phone-normalizer.js
                // 
                // WHY: chrome.scripting.executeScript() runs in PAGE CONTEXT, not
                // extension context. ES6 imports are NOT available here.
                // 
                // CANONICAL SOURCE: lib/phone-normalizer.js:normalizePhone
                // SYNC REQUIREMENT: Keep this in sync with lib/phone-normalizer.js
                // Last synced: 2026-06-09 (PHONE-01: IT default for 06/07 landlines)
                // ═══════════════════════════════════════════════════════════════
                function normalizePhone(phone) {
                    if (!phone) return '';

                    // Convert to string and trim
                    const phoneStr = String(phone).trim();

                    // Already has country code, return as-is
                    if (phoneStr.startsWith('+')) {
                        return phoneStr;
                    }

                    // Remove common formatting but preserve the number
                    const cleaned = phoneStr.replace(/[\s\.\-()]/g, '');

                    // Italian mobile: starts with 3, followed by 9 digits (total 10)
                    if (/^3\d{9}$/.test(cleaned)) {
                        return '+39' + cleaned;
                    }

                    // PHONE-01 FIX (2026-06-09): Italian landline (Rome=06, 07).
                    // This scraper only ever sees Italian Maps data, so a 10-digit
                    // 06/07 number is an Italian landline, NOT a French mobile.
                    // Mirrors the IT default in lib/phone-normalizer.js.
                    if (/^0[67]\d{8}$/.test(cleaned)) {
                        const areaCode = cleaned.substring(0, 2);
                        const subscriber = cleaned.substring(2);
                        return '+39 ' + areaCode + ' ' + subscriber;
                    }

                    // German mobile: starts with 015, 016, 017 (total 11-13)
                    if (/^01[567]\d{7,9}$/.test(cleaned)) {
                        return '+49' + cleaned.substring(1);
                    }

                    // Spanish mobile: starts with 6 or 7 (total 9)
                    if (/^[67]\d{8}$/.test(cleaned)) {
                        return '+34' + cleaned;
                    }

                    // UK mobile: starts with 07 (total 11)
                    if (/^07\d{9}$/.test(cleaned)) {
                        return '+44' + cleaned.substring(1);
                    }

                    // For landlines and other formats, return original
                    return phoneStr;
                }

                function extractPhone(text) {
                    const patterns = [
                        // Italian mobile +39 3xx
                        /(\+39\s*3\d{2}\s*\d{3}\s*\d{4})/,
                        /(\+39\s*3\d{2}\s*\d{2}\s*\d{2}\s*\d{3})/,
                        // Italian landline +39 0xx
                        /(\+39\s*0\d{1,4}\s*\d{4,8})/,
                        // Without +39
                        /\b(3\d{2}\s*\d{3}\s*\d{4})\b/,
                        /\b(3\d{2}\s*\d{2}\s*\d{2}\s*\d{3})\b/,
                        /\b(0\d{1,3}\s*\d{3}\s*\d{4})\b/,
                        /\b(0\d{2,4}\s*\d{5,8})\b/,
                        // Generic international
                        /(\+\d{1,3}\s*\d{2,4}\s*\d{4,8})/
                    ];

                    for (const pattern of patterns) {
                        const match = text.match(pattern);
                        if (match) {
                            const phone = (match[1] || match[0]).replace(/[\s\.\-()]/g, '');
                            const digits = phone.replace(/\D/g, '');
                            if (digits.length >= 9 && digits.length <= 15) {
                                // Normalize phone immediately on extraction
                                // This adds +39 to Italian mobiles, preserves landlines
                                return normalizePhone(phone);
                            }
                        }
                    }
                    return null;
                }

                // ========== MAIN EXTRACTION ==========

                const businesses = [];
                const seen = new Set();

                // Find all business links
                const links = document.querySelectorAll('a[href*="/maps/place/"]');

                links.forEach(link => {
                    try {
                        const url = link.href;
                        if (!url || !url.includes('/maps/place/')) return;

                        // H-01 fix (D.3 + H01-area-search-strip-fix audit, 2026-05-09):
                        // Pre-fix did `url = url.split('?')[0]` and used the
                        // stripped form BOTH for local dedup AND for the
                        // payload `googleMapsUrl`. When Maps emits the data-
                        // param (`!1s0xHEX:0xHEX`) in the QUERYSTRING (shape B
                        // of D.3 corpus), the strip dropped the !1s and
                        // `getCanonicalDbKey` fell back to the placeholder-only
                        // form. Path A (here) and Path B (DOM observer with
                        // full URL) then produced different DB keys → 2 records
                        // for the same business.
                        //
                        // Post-fix: derive a `seenKey` for LOCAL per-tab dedup
                        // (which still wants the strip — we don't want different
                        // querystrings of the same place to count as separate)
                        // and pass the FULL `url` in the payload so
                        // `getCanonicalDbKey` in handleBusinessFound has the
                        // complete data-param to canonicalize from.
                        // Test: tests/run-h01-area-search-payload-node.mjs.
                        const seenKey = url.split('?')[0];
                        if (seen.has(seenKey)) return;
                        seen.add(seenKey);

                        // Find container
                        const container = link.closest('[role="article"]') ||
                            link.closest('div[jsaction*="mouseover"]') ||
                            link.closest('.Nv2PK') ||
                            link.closest('[jslog]') ||
                            link.parentElement?.parentElement?.parentElement?.parentElement;

                        if (!container) return;

                        const text = container.innerText || '';

                        // TITLE
                        const titleEl = container.querySelector('.fontHeadlineSmall') ||
                            container.querySelector('[role="heading"]') ||
                            container.querySelector('.qBF1Pd') ||
                            container.querySelector('.NrDZNb') ||
                            container.querySelector('.fontTitleLarge');

                        let title = titleEl?.textContent?.trim();
                        if (!title) {
                            const ariaLabel = link.getAttribute('aria-label') || '';
                            title = ariaLabel.split('·')[0]?.trim() || 'Unknown';
                        }

                        // RATING
                        const ratingEl = container.querySelector('.MW4etd') ||
                            container.querySelector('[aria-label*="stell"]');
                        let rating = null;
                        if (ratingEl) {
                            const rText = ratingEl.textContent || ratingEl.getAttribute('aria-label') || '';
                            const rMatch = rText.match(/(\d[.,]\d)/);
                            if (rMatch) rating = parseFloat(rMatch[1].replace(',', '.'));
                        }

                        // REVIEWS
                        const reviewsEl = container.querySelector('.UY7F9');
                        let reviews = null;
                        if (reviewsEl) {
                            const rvText = reviewsEl.textContent || '';
                            const rvMatch = rvText.match(/[\d.,]+/);
                            if (rvMatch) reviews = parseInt(rvMatch[0].replace(/[.,]/g, ''));
                        }

                        // WEBSITE (ENHANCED!)
                        const website = extractWebsite(container, text);

                        // PHONE (ENHANCED!)
                        const phone = extractPhone(text);

                        // CATEGORY
                        let category = null;
                        const catText = container.querySelector('.W4Efsd')?.textContent || '';
                        if (catText) {
                            const catParts = catText.split('·');
                            if (catParts[0]) category = catParts[0].trim();
                        }

                        // ADDRESS — W4Efsd-anchor extraction (MCP-B fix, 2026-05-08).
                        //
                        // The previous regex /(?:Via|Viale|...)/i matched against the
                        // whole container.innerText (which INCLUDES the title and
                        // review snippet), with case-insensitive + greedy [^·\n]+.
                        // Three bug classes were observed live on 6 cards from
                        // /maps/search/ristoranti+Milano (1 in 6 each, 50% combined):
                        //   BUG-EE-1 title-trap: "Via Pasteria - Daniele Crespi"
                        //     (restaurant name) matched as address.
                        //   BUG-EE-2 prefix-gap: "Piazzetta" / "Vico" / "Calata" /
                        //     "Discesa" / "Traversa" / "Galleria" / "Riva" missing
                        //     from the prefix list — silent drop.
                        //   BUG-EE-3 civico-lost: "<civico> Via <street>" lost the
                        //     leading civico (cosmetic, fixed by capturing the
                        //     full address segment).
                        //
                        // Fix: anchor on the .W4Efsd DOM rows (Maps cards use those
                        // for category/address/hours layout). The title is never in
                        // .W4Efsd, so the title-trap is structurally impossible.
                        // Maps nests two .W4Efsd rows inside a parent .W4Efsd, so
                        // querySelectorAll returns both the parent (collapsed
                        // address+hours concat) and the children (clean). We
                        // collect ALL candidates that match the prefix pattern and
                        // return the SHORTEST (the clean dedicated row).
                        // Prefix list extended with regional Italian street types.
                        // See tests/run-list-card-extractor-node.mjs for spec.
                        let address = null;
                        {
                            const ADDRESS_PREFIX_REGEX = /^(\d+\s+)?(Viale|Vicolo|Via|Piazzetta|Piazzale|Piazza|Corso|Largo|Strada|Lungomare|Salita|Vico|Calata|Discesa|Traversa|Galleria|Riva)\s/;
                            const candidates = [];
                            const rows = container.querySelectorAll('.W4Efsd');
                            rows.forEach(rowEl => {
                                const row = rowEl?.textContent?.trim() || '';
                                if (!row) return;
                                // Skip rating-only rows like "4,5(1155) · 30-80 €"
                                if (/^\d[,.]\d?\s*\(\d/.test(row)) return;
                                // Skip pure hours rows
                                const lastPart = row.split('·').slice(-1)[0]?.trim() || '';
                                if (/^(Aperto|Chiuso|Apre|Chiude|Apre tra)\b/.test(row) &&
                                    !ADDRESS_PREFIX_REGEX.test(lastPart)) return;
                                const parts = row.split('·').map(p => p.trim()).filter(Boolean);
                                for (const p of parts) {
                                    if (ADDRESS_PREFIX_REGEX.test(p)) candidates.push(p);
                                }
                            });
                            if (candidates.length > 0) {
                                candidates.sort((a, b) => a.length - b.length);
                                address = candidates[0];
                            }
                        }

                        businesses.push({
                            googleMapsUrl: url,
                            title,
                            rating,
                            reviews,
                            phone,
                            website,
                            category,
                            address,
                            timestamp: Date.now(),
                            emailScraped: false
                        });

                    } catch (e) {
                        // Skip
                    }
                });

                return businesses;
            }
        });

        return results?.[0]?.result || [];
    } catch (e) {
        return [];
    }
}

// =====================================================
// HELPERS
// =====================================================

async function injectHumanScroll(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                // ═══════════════════════════════════════════════════════════════════
                // NSA-GRADE SCROLL ENGINE v1.0 - 150% Implementation
                // Features: State Machine, MutationObserver, Position Intelligence,
                //           Multi-Signal Completion, Human Behavior, Telemetry
                // ═══════════════════════════════════════════════════════════════════

                // Initialize completion flags for polling from main loop
                window.__GHOST_SCROLL_COMPLETE__ = false;
                window.__GHOST_SCROLL_COUNT__ = 0;
                window.__GHOST_SCROLL_TELEMETRY__ = null;

                // ═══════════════════════════════════════════════════════════════════
                // LAYER 1: STATE MACHINE
                // States: INITIALIZING → SCROLLING → WAITING_CONTENT → VERIFYING → COMPLETE
                // ═══════════════════════════════════════════════════════════════════
                const StateMachine = {
                    state: 'INITIALIZING',
                    previousState: null,
                    stateHistory: [],

                    transition(newState) {
                        this.previousState = this.state;
                        this.stateHistory.push({ from: this.state, to: newState, time: Date.now() });
                        this.state = newState;
                        console.log(`[NSA-SCROLL] State: ${this.previousState} → ${newState}`);
                    },

                    is(state) {
                        return this.state === state;
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // LAYER 2: MUTATION OBSERVER INTELLIGENCE
                // Watch for new content, track mutations, wait for stability
                // ═══════════════════════════════════════════════════════════════════
                const MutationIntelligence = {
                    observer: null,
                    lastMutationTime: Date.now(),
                    mutationCount: 0,
                    newCardsCount: 0,

                    startWatching(container) {
                        this.observer = new MutationObserver((mutations) => {
                            // Track new business cards specifically
                            let foundNewCards = 0;

                            for (const mutation of mutations) {
                                for (const node of mutation.addedNodes) {
                                    if (node.nodeType === 1) {
                                        // Check if this is a business card or contains one
                                        if (node.matches?.('[role="article"]') ||
                                            node.querySelector?.('[role="article"]') ||
                                            node.matches?.('[jsaction*="mouseover"]') ||
                                            node.querySelector?.('[jsaction*="mouseover"]')) {
                                            foundNewCards++;
                                        }
                                    }
                                }
                            }

                            if (foundNewCards > 0 || mutations.length > 0) {
                                this.lastMutationTime = Date.now();
                                this.mutationCount += mutations.length;
                                this.newCardsCount += foundNewCards;
                            }
                        });

                        this.observer.observe(container, {
                            childList: true,
                            subtree: true
                        });

                        console.log('[NSA-SCROLL] MutationObserver started');
                    },

                    // Wait for content to stabilize (no new mutations for stabilityMs)
                    async waitForStability(stabilityMs = 800, timeoutMs = 3000) {
                        const startTime = Date.now();

                        while (Date.now() - startTime < timeoutMs) {
                            const timeSinceMutation = Date.now() - this.lastMutationTime;
                            if (timeSinceMutation > stabilityMs) {
                                return { stabilized: true, waited: Date.now() - startTime };
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }

                        return { stabilized: false, waited: timeoutMs };
                    },

                    getTimeSinceLastMutation() {
                        return Date.now() - this.lastMutationTime;
                    },

                    reset() {
                        this.lastMutationTime = Date.now();
                    },

                    cleanup() {
                        if (this.observer) {
                            this.observer.disconnect();
                            this.observer = null;
                        }
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // LAYER 3: POSITION INTELLIGENCE
                // Track scroll position, detect true bottom, calculate progress
                // ═══════════════════════════════════════════════════════════════════
                const PositionIntelligence = {
                    getScrollState(container) {
                        const scrollTop = container.scrollTop;
                        const clientHeight = container.clientHeight;
                        const scrollHeight = container.scrollHeight;

                        const scrollableDistance = scrollHeight - clientHeight;
                        const currentProgress = scrollableDistance > 0 ? scrollTop / scrollableDistance : 1;
                        const distanceToBottom = scrollHeight - scrollTop - clientHeight;

                        return {
                            scrollTop,
                            clientHeight,
                            scrollHeight,
                            scrollableDistance,
                            progress: Math.round(currentProgress * 100),
                            distanceToBottom,
                            isAtBottom: distanceToBottom < 50,
                            isScrollable: scrollableDistance > 10,
                            estimatedCards: Math.floor(scrollHeight / 120)
                        };
                    },

                    // Check if scroll actually moved after command
                    async verifyScrollMoved(container, expectedDelta) {
                        const before = container.scrollTop;
                        await new Promise(r => setTimeout(r, 100));
                        const after = container.scrollTop;
                        const actualDelta = after - before;

                        return {
                            moved: Math.abs(actualDelta) > 5,
                            delta: actualDelta,
                            efficiency: expectedDelta > 0 ? actualDelta / expectedDelta : 0
                        };
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // LAYER 4: MULTI-SIGNAL COMPLETION DETECTION
                // 5 signals, require 3+ for completion (60% confidence)
                // ═══════════════════════════════════════════════════════════════════
                const CompletionDetector = {
                    signals: {
                        endTextDetected: false,
                        googleEndMarker: false,
                        atPhysicalBottom: false,
                        noNewMutations: false,
                        heightStable: false
                    },
                    heightHistory: [],

                    checkEndText(container) {
                        const endPhrases = [
                            "fine dell'elenco",
                            "reached the end",
                            "no more results",
                            "nessun altro risultato",
                            "hai raggiunto la fine",
                            "you've reached the end"
                        ];
                        const text = (container.textContent || '').toLowerCase();
                        return endPhrases.some(phrase => text.includes(phrase));
                    },

                    checkGoogleEndMarker() {
                        const endMarker = document.querySelector('.HlvSq');
                        if (endMarker) {
                            const text = (endMarker.textContent || '').toLowerCase();
                            return text.includes('fine') || text.includes('end') || text.includes('elenco');
                        }
                        return false;
                    },

                    checkNoResults(container) {
                        const noResultPhrases = [
                            'nessun risultato',
                            'no results',
                            'non sono stati trovati risultati'
                        ];
                        const text = (container.textContent || '').toLowerCase();
                        return noResultPhrases.some(phrase => text.includes(phrase));
                    },

                    recordHeight(height) {
                        this.heightHistory.push({ height, time: Date.now() });
                        // Keep only last 10 entries
                        if (this.heightHistory.length > 10) {
                            this.heightHistory.shift();
                        }
                    },

                    isHeightStable(minSameCount = 5) {
                        if (this.heightHistory.length < minSameCount) return false;

                        const recent = this.heightHistory.slice(-minSameCount);
                        const firstHeight = recent[0].height;
                        return recent.every(h => h.height === firstHeight);
                    },

                    evaluate(container, scrollState, mutationState, scrollCount) {
                        // Minimum scrolls before allowing completion
                        const minScrolls = 10;
                        if (scrollCount < minScrolls) {
                            return { isComplete: false, confidence: 0, reason: 'min_scrolls', signals: this.signals };
                        }

                        // Check for "no results" - immediate exit
                        if (this.checkNoResults(container)) {
                            return { isComplete: true, confidence: 1.0, reason: 'no_results', signals: this.signals };
                        }

                        // Update signals
                        this.signals.endTextDetected = this.checkEndText(container);
                        this.signals.googleEndMarker = this.checkGoogleEndMarker();
                        this.signals.atPhysicalBottom = scrollState.isAtBottom;
                        this.signals.noNewMutations = mutationState.getTimeSinceLastMutation() > 2000;
                        this.signals.heightStable = this.isHeightStable(5);

                        // Count active signals
                        const activeSignals = Object.values(this.signals).filter(Boolean).length;
                        const confidence = activeSignals / 5;

                        // Need 3+ signals (60% confidence) for completion
                        const isComplete = activeSignals >= 3;

                        return {
                            isComplete,
                            confidence,
                            activeSignals,
                            signals: { ...this.signals },
                            reason: isComplete ? 'multi_signal' : 'insufficient_signals'
                        };
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // LAYER 5: HUMAN BEHAVIOR PATTERNS
                // Burst scrolling, reading pauses, occasional scroll-backs
                // ═══════════════════════════════════════════════════════════════════
                const HumanBehavior = {
                    phase: 'eager', // 'eager' | 'steady' | 'careful'
                    scrollsSinceStart: 0,

                    updatePhase(progress) {
                        if (progress < 50) this.phase = 'eager';
                        else if (progress < 80) this.phase = 'steady';
                        else this.phase = 'careful';
                    },

                    getScrollAmount(viewHeight) {
                        let baseMultiplier;

                        switch (this.phase) {
                            case 'eager':
                                // SUPER AGGRESSIVE: 200-350% of viewport (smashing scroll wheel)
                                baseMultiplier = 2.0 + Math.random() * 1.5;
                                break;
                            case 'steady':
                                // SUPER AGGRESSIVE: 150-250% of viewport
                                baseMultiplier = 1.5 + Math.random() * 1.0;
                                break;
                            case 'careful':
                                // Still fast: 100-150% of viewport
                                baseMultiplier = 1.0 + Math.random() * 0.5;
                                break;
                            default:
                                baseMultiplier = 1.5 + Math.random() * 1.0;
                        }

                        return viewHeight * baseMultiplier;
                    },

                    shouldTakeReadingPause() {
                        // MINIMAL: 1% chance of reading pause (super speed mode)
                        return Math.random() < 0.01;
                    },

                    getReadingPauseDuration() {
                        // 1-3 seconds
                        return 1000 + Math.random() * 2000;
                    },

                    shouldScrollBack() {
                        // DISABLED: No scroll backs in super speed mode
                        return false;
                    },

                    getScrollBackAmount(viewHeight) {
                        // Small scroll back: 50-150px
                        return -(50 + Math.random() * 100);
                    },

                    getNextScrollDelay() {
                        // SUPER FAST: Base delay 50-150ms (like rapid scroll wheel)
                        let delay = 50 + Math.random() * 100;

                        // 5% chance of tiny pause (was 10%)
                        if (Math.random() < 0.05) {
                            delay += 100 + Math.random() * 150;
                        }

                        // 20% chance of instant next scroll
                        if (Math.random() < 0.20) {
                            delay = 20 + Math.random() * 30;
                        }

                        return delay;
                    },

                    incrementScroll() {
                        this.scrollsSinceStart++;
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // LAYER 6: TELEMETRY
                // Full metrics for debugging and performance analysis
                // ═══════════════════════════════════════════════════════════════════
                const Telemetry = {
                    startTime: Date.now(),
                    scrollEvents: 0,
                    totalPixelsScrolled: 0,
                    readingPauses: 0,
                    scrollBacks: 0,
                    stateTransitions: 0,
                    maxHeight: 0,

                    recordScroll(pixels) {
                        this.scrollEvents++;
                        this.totalPixelsScrolled += Math.abs(pixels);
                    },

                    recordReadingPause() {
                        this.readingPauses++;
                    },

                    recordScrollBack() {
                        this.scrollBacks++;
                    },

                    updateMaxHeight(height) {
                        if (height > this.maxHeight) {
                            this.maxHeight = height;
                        }
                    },

                    getReport() {
                        const elapsed = Date.now() - this.startTime;
                        const elapsedSec = elapsed / 1000;

                        return {
                            elapsedMs: elapsed,
                            elapsedSec: Math.round(elapsedSec * 10) / 10,
                            scrollEvents: this.scrollEvents,
                            totalPixelsScrolled: this.totalPixelsScrolled,
                            readingPauses: this.readingPauses,
                            scrollBacks: this.scrollBacks,
                            maxHeight: this.maxHeight,
                            scrollsPerSecond: elapsedSec > 0 ? Math.round(this.scrollEvents / elapsedSec * 10) / 10 : 0,
                            pixelsPerSecond: elapsedSec > 0 ? Math.round(this.totalPixelsScrolled / elapsedSec) : 0
                        };
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // SMOOTH SCROLL HELPER
                // ═══════════════════════════════════════════════════════════════════
                function smoothScroll(container, amount) {
                    return new Promise((resolve) => {
                        const startPos = container.scrollTop;
                        const targetPos = Math.max(0, Math.min(
                            startPos + amount,
                            container.scrollHeight - container.clientHeight
                        ));

                        const duration = 150 + Math.random() * 250;
                        const startTime = performance.now();

                        const animateScroll = (currentTime) => {
                            const elapsed = currentTime - startTime;
                            const progress = Math.min(elapsed / duration, 1);
                            const eased = 1 - (1 - progress) * (1 - progress);
                            container.scrollTop = startPos + (targetPos - startPos) * eased;

                            if (progress < 1) {
                                requestAnimationFrame(animateScroll);
                            } else {
                                resolve(targetPos - startPos);
                            }
                        };

                        requestAnimationFrame(animateScroll);
                    });
                }

                // ═══════════════════════════════════════════════════════════════════
                // CONTAINER POLLING
                // ═══════════════════════════════════════════════════════════════════
                let containerAttempts = 0;
                const maxContainerAttempts = 20;

                const waitForContainer = () => {
                    const container = document.querySelector('[role="feed"]') ||
                        document.querySelector('.m6QErb.DxyBCb') ||
                        document.querySelector('.m6QErb');

                    const hasResults = container && container.querySelectorAll('[jsaction*="mouseover"]').length > 0;

                    if (container && hasResults) {
                        console.log(`[NSA-SCROLL] ✓ Container found after ${containerAttempts * 500}ms`);
                        startNSAScroll(container);
                    } else if (containerAttempts++ < maxContainerAttempts) {
                        setTimeout(waitForContainer, 500);
                    } else {
                        console.error('[NSA-SCROLL] ✗ Container not found after 10s');
                        window.__GHOST_SCROLL_COMPLETE__ = true;
                        window.__GHOST_SCROLL_COUNT__ = 0;
                    }
                };

                // ═══════════════════════════════════════════════════════════════════
                // MAIN NSA SCROLL ENGINE
                // ═══════════════════════════════════════════════════════════════════
                async function startNSAScroll(container) {
                    // Start mutation observer
                    MutationIntelligence.startWatching(container);

                    // Initial delay to let page settle
                    await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));

                    const maxScrolls = 200; // Safety limit
                    let scrollCount = 0;
                    let verifyAttempts = 0;

                    // Main state machine loop
                    while (!StateMachine.is('COMPLETE')) {
                        const scrollState = PositionIntelligence.getScrollState(container);
                        Telemetry.updateMaxHeight(scrollState.scrollHeight);
                        CompletionDetector.recordHeight(scrollState.scrollHeight);

                        // Update debug window variable
                        window.__GHOST_SCROLL_DEBUG__ = {
                            state: StateMachine.state,
                            scrollCount,
                            height: scrollState.scrollHeight,
                            progress: scrollState.progress,
                            phase: HumanBehavior.phase,
                            signals: CompletionDetector.signals
                        };

                        switch (StateMachine.state) {
                            case 'INITIALIZING':
                                // Check if container is scrollable
                                if (!scrollState.isScrollable) {
                                    console.log('[NSA-SCROLL] Container not scrollable, completing');
                                    StateMachine.transition('COMPLETE');
                                    break;
                                }

                                // Check for "no results"
                                if (CompletionDetector.checkNoResults(container)) {
                                    console.log('[NSA-SCROLL] No results found, completing');
                                    StateMachine.transition('COMPLETE');
                                    break;
                                }

                                StateMachine.transition('SCROLLING');
                                break;

                            case 'SCROLLING':
                                // Safety limit
                                if (scrollCount >= maxScrolls) {
                                    console.log(`[NSA-SCROLL] Safety limit (${maxScrolls}) reached`);
                                    StateMachine.transition('COMPLETE');
                                    break;
                                }

                                // Update phase based on progress
                                HumanBehavior.updatePhase(scrollState.progress);

                                // Check for reading pause
                                if (HumanBehavior.shouldTakeReadingPause()) {
                                    const pauseDuration = HumanBehavior.getReadingPauseDuration();
                                    console.log(`[NSA-SCROLL] 📖 Reading pause: ${Math.round(pauseDuration)}ms`);
                                    Telemetry.recordReadingPause();
                                    await new Promise(r => setTimeout(r, pauseDuration));
                                }

                                // Check for scroll back
                                if (HumanBehavior.shouldScrollBack()) {
                                    const scrollBackAmount = HumanBehavior.getScrollBackAmount(scrollState.clientHeight);
                                    console.log(`[NSA-SCROLL] ↩️ Scroll back: ${Math.round(scrollBackAmount)}px`);
                                    await smoothScroll(container, scrollBackAmount);
                                    Telemetry.recordScrollBack();
                                    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
                                }

                                // Calculate scroll amount
                                const scrollAmount = HumanBehavior.getScrollAmount(scrollState.clientHeight);

                                // Reset mutation timer before scrolling
                                MutationIntelligence.reset();

                                // Perform scroll
                                const actualScroll = await smoothScroll(container, scrollAmount);
                                scrollCount++;
                                HumanBehavior.incrementScroll();
                                Telemetry.recordScroll(actualScroll);
                                window.__GHOST_SCROLL_COUNT__ = scrollCount;

                                // Transition to waiting for content
                                StateMachine.transition('WAITING_CONTENT');
                                break;

                            case 'WAITING_CONTENT':
                                // Wait for DOM to stabilize
                                const stability = await MutationIntelligence.waitForStability(800, 2500);

                                // Evaluate completion
                                const completionCheck = CompletionDetector.evaluate(
                                    container,
                                    PositionIntelligence.getScrollState(container),
                                    MutationIntelligence,
                                    scrollCount
                                );

                                if (completionCheck.isComplete) {
                                    console.log(`[NSA-SCROLL] 🎯 Completion detected: ${completionCheck.activeSignals}/5 signals (${Math.round(completionCheck.confidence * 100)}%)`);
                                    StateMachine.transition('VERIFYING');
                                } else {
                                    // Add delay before next scroll
                                    const delay = HumanBehavior.getNextScrollDelay();
                                    await new Promise(r => setTimeout(r, delay));
                                    StateMachine.transition('SCROLLING');
                                }
                                break;

                            case 'VERIFYING':
                                // Final verification: scroll once more and confirm
                                console.log('[NSA-SCROLL] 🔍 Verifying completion...');

                                // Visual indicator
                                if (!document.getElementById('__ghost_scroll_overlay__')) {
                                    const overlay = document.createElement('div');
                                    overlay.id = '__ghost_scroll_overlay__';
                                    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,165,0,0.15);pointer-events:none;z-index:999999;transition:background 0.5s;';
                                    document.body.appendChild(overlay);
                                }

                                await smoothScroll(container, 200);
                                scrollCount++;
                                window.__GHOST_SCROLL_COUNT__ = scrollCount;

                                await new Promise(r => setTimeout(r, 1500));

                                const finalCheck = CompletionDetector.evaluate(
                                    container,
                                    PositionIntelligence.getScrollState(container),
                                    MutationIntelligence,
                                    scrollCount
                                );

                                if (finalCheck.confidence >= 0.4 || verifyAttempts >= 2) {
                                    // Update overlay to red for confirmed completion
                                    const overlay = document.getElementById('__ghost_scroll_overlay__');
                                    if (overlay) {
                                        overlay.style.background = 'rgba(255,0,0,0.15)';
                                    }
                                    StateMachine.transition('COMPLETE');
                                } else {
                                    // False positive, reset overlay and continue
                                    const overlay = document.getElementById('__ghost_scroll_overlay__');
                                    if (overlay) overlay.remove();

                                    console.log('[NSA-SCROLL] ⚠️ False positive, continuing...');
                                    verifyAttempts++;
                                    StateMachine.transition('SCROLLING');
                                }
                                break;

                            case 'COMPLETE':
                                // This case is handled by the while loop condition
                                break;
                        }
                    }

                    // Cleanup
                    MutationIntelligence.cleanup();

                    // Final telemetry
                    const report = Telemetry.getReport();
                    window.__GHOST_SCROLL_TELEMETRY__ = report;
                    window.__GHOST_SCROLL_COMPLETE__ = true;

                    console.log('[NSA-SCROLL] ✅ COMPLETE');
                    console.log(`[NSA-SCROLL] 📊 Stats: ${report.scrollEvents} scrolls, ${report.maxHeight}px max, ${report.elapsedSec}s`);
                }

                // Start container polling
                waitForContainer();
            }
        });
    } catch (e) {
        console.error(`[NSA-SCROLL] Injection failed for tab ${tabId}:`, e.message);

        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    window.__GHOST_SCROLL_COMPLETE__ = true;
                    window.__GHOST_SCROLL_COUNT__ = 0;
                }
            });
            console.log(`[NSA-SCROLL] Set fallback completion flag for tab ${tabId}`);
        } catch (fallbackError) {
            console.warn(`[NSA-SCROLL] Could not set fallback completion flag for tab ${tabId}`);
        }
    }
}

function broadcastProgress() {
    // AS-02 FIX (2026-06-10): guard the idle state. With total=0 the old
    // `(current/0)*100` produced NaN (serialized to null over sendMessage →
    // UI showed "null%"); with startTime=null `Date.now() - null` produced
    // an epoch-sized elapsed. Both reachable via pause/resume at idle.
    const elapsed = TURBO_STATE.startTime ? Date.now() - TURBO_STATE.startTime : 0;
    const current = TURBO_STATE.completedSearches;
    const total = TURBO_STATE.totalSearches;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;

    const avgTime = current > 0 ? elapsed / current : 2000;
    const remaining = (total - current) * avgTime;

    chrome.runtime.sendMessage({
        action: 'area_search_progress',
        payload: {
            isRunning: TURBO_STATE.isRunning,
            isPaused: TURBO_STATE.isPaused,
            current,
            total,
            percent,
            currentBatch: TURBO_STATE.currentBatch,
            totalBatches: TURBO_STATE.totalBatches,
            elapsed: formatDuration(elapsed),
            remaining: formatDuration(remaining),
            stats: TURBO_STATE.stats,
            turboMode: true
        }
    }).catch(() => { });
}

async function finishTurbo() {
    TURBO_STATE.isRunning = false;
    const duration = Date.now() - TURBO_STATE.startTime;

    // OBS-4 (2026-05-17): reconcile dialog stats with DB-truth.
    //
    // Bugs this fixes:
    //   G — "Businesses found: 0" in dialog while main UI shows 141. The
    //       accumulator `stats.businessesFound` counts only NEW unique-saved
    //       this session (correct semantic but UX-confusing when all 141
    //       were already in DB from previous scrapes).
    //   H — "With phone: 475" for 141 businesses (3.4× overcounting).
    //       `_applyBatchStatsToTurbo` does `stats.withPhone += batch.phones`
    //       and `batch.phones` is incremented per-business-per-grid-cell.
    //       The same business in 3 adjacent grid cells contributes 3× to
    //       phone count. Same anti-pattern for withWebsite.
    //   I — UI/dialog race: completion dialog fires before sidebar progress
    //       has reached 100%. Fixed by final broadcastProgress() + 150ms
    //       sleep BEFORE area_search_complete dispatch.
    //
    // Strategy: at end of turbo, query DB and overwrite stats with truth.
    // The dialog will now show the same numbers as the main UI sidepanel.
    // Per-run accumulators are preserved as `newBusinessesThisRun` /
    // `duplicatesFound` for observability.
    //
    // Trade-off / FOLLOW-UP: getAllBusinesses() is O(N) where N is total
    // DB size. For DBs >10k businesses this adds noticeable latency. A
    // future db.countBusinesses() / db.countWithWebsite() helper would
    // make this O(1). Tracking as scaling debt; for current usage (<2k)
    // the latency is <50ms.
    const newThisRun = TURBO_STATE.stats.businessesFound;
    const duplicatesThisRun = TURBO_STATE.stats.duplicatesFound || 0;

    try {
        // OBS-5 INSTRUMENTATION (2026-05-18): live dogfooding measured ~14s
        // wall-clock between this log line and `area_search_complete` arrival
        // at UI. Expected <100ms for ~135 records. Add per-phase timing so
        // we can pin the root cause:
        //   (a) IndexedDB store.getAll() raw cost
        //   (b) Array.filter() iteration cost (rich JSPB blobs)
        //   (c) Implicit serialization across structured-clone boundary
        //   (d) Lock contention with concurrent save_business_batch writes
        //
        // The 4 phase markers are emitted as plain log lines so the dev-log
        // bridge surfaces them. Sample first record size to bound (c).
        // SAVE-DLQ (2026-05-28): recover records dead-lettered by THIS or prior
        // runs BEFORE counting DB-truth, so recovered rows are reflected in the
        // total. Single-attempt (retry:false) + budgeted (≤100 records / ≤3s) so
        // a large queue can never stall finalize. Self-guarded — a drain failure
        // never aborts completion.
        let recoveredFromQueue = 0;
        try {
            const drainRes = await drainDeadLetter(
                (b) => dbInstance.saveBusiness(b, { retry: false }),
                { maxRecords: 100, maxMs: 3000 }
            );
            recoveredFromQueue = drainRes.drained;
            if (drainRes.drained || drainRes.agedOut) {
                console.log(`[TURBO finalize] DLQ drain: recovered ${drainRes.drained}, aged-out ${drainRes.agedOut}, ${drainRes.remaining} remaining`);
            }
        } catch (drainErr) {
            console.warn(`[TURBO finalize] DLQ drain skipped: ${drainErr?.message || drainErr}`);
        }
        const pendingInQueue = await getDeadLetterCount().catch(() => 0);

        const t0 = performance.now();
        const all = await dbInstance.getAllBusinesses();
        const t1 = performance.now();
        console.log(`[TURBO finalize] getAllBusinesses() returned ${Array.isArray(all) ? all.length : 'non-array'} records in ${(t1 - t0).toFixed(1)}ms`);
        if (Array.isArray(all)) {
            // Sample first record size to test hypothesis (c) — rich JSPB
            // blobs blowing up structured-clone deserialization cost.
            if (all.length > 0) {
                try {
                    const firstSize = JSON.stringify(all[0]).length;
                    console.log(`[TURBO finalize] First record JSON size: ${firstSize}B (avg if uniform: ${(firstSize * all.length / 1024).toFixed(1)}KB total)`);
                } catch { /* ignore */ }
            }
            const t2 = performance.now();
            const totalCount = all.length;
            const withWebsiteCount = all.filter(b => b && b.website).length;
            const withPhoneCount = all.filter(b => b && b.phone).length;
            const t3 = performance.now();
            console.log(`[TURBO finalize] filter+count (3 passes) over ${all.length} records in ${(t3 - t2).toFixed(1)}ms`);

            // Overwrite with DB-truth. Keep newBusinessesThisRun /
            // duplicatesFound so the dialog can show both perspectives.
            TURBO_STATE.stats = {
                ...TURBO_STATE.stats,
                businessesFound: totalCount,
                withWebsite: withWebsiteCount,
                withPhone: withPhoneCount,
                newBusinessesThisRun: newThisRun,
                duplicatesFound: duplicatesThisRun,
                // SAVE-DLQ (2026-05-28): surface save loss instead of masking it.
                // failedSaveEvents = this-run failure events (diagnostic);
                // pendingInQueue = authoritative records still awaiting retry
                // (global DLQ depth, post-drain — labelled "in totale" in the UI);
                // recoveredFromQueue = records recovered from prior runs.
                failedSaveEvents: TURBO_STATE.stats.failedSaveEvents || 0,
                quotaFailures: TURBO_STATE.stats.quotaFailures || 0,
                dlqDropped: TURBO_STATE.stats.dlqDropped || 0,
                pendingInQueue,
                recoveredFromQueue
            };
        }
    } catch (e) {
        // Graceful fallback: if DB query fails, leave existing accumulator
        // stats in place. Worst case dialog shows the old (wrong) numbers,
        // but the user still gets a completion signal.
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[TURBO finalize] DB-truth reconciliation failed: ${msg}`);
    }

    console.log('\n✅ TURBO v3 COMPLETE!');
    console.log(`⏱️ Duration: ${formatDuration(duration)}`);
    console.log(`📊 Stats (DB-truth):`);
    console.log(`   Businesses: ${TURBO_STATE.stats.businessesFound} (${newThisRun} new this run, ${duplicatesThisRun} already in DB)`);
    console.log(`   With website: ${TURBO_STATE.stats.withWebsite}`);
    console.log(`   With phone: ${TURBO_STATE.stats.withPhone}`);

    // OBS-4 race fix (Finding I): broadcast the final state to UI and give
    // it a tick to render BEFORE the area_search_complete dispatch (which
    // triggers the alert dialog). Without this, the sidebar can still
    // be showing "Searching... 80%" while the dialog appears.
    //
    // 150ms is below UX-perception threshold (~200ms) and ample for the
    // browser to process the in-flight message before the next.
    try { broadcastProgress(); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 150));

    chrome.runtime.sendMessage({
        action: 'area_search_complete',
        payload: {
            duration: formatDuration(duration),
            stats: TURBO_STATE.stats
        }
    }).catch(() => { });

    // AS-01 FIX (2026-06-10): sweep orphan windows BEFORE resetTurboState()
    // wipes openTabs (losing the IDs forever — the pre-fix bug: after a run
    // finished on its own, leftover popups could never be closed, not even by
    // Stop). No-op in the common case (per-batch cleanupTabs already closed
    // and untracked everything); only fires when an eviction mid-run left
    // ledger entries behind.
    try {
        await _closeOrphanWindows('TURBO finalize');
    } catch (e) {
        console.warn('[TURBO finalize] orphan sweep failed:', e instanceof Error ? e.message : String(e));
    }

    // CRITICAL: Reset state to prevent memory leaks
    resetTurboState();
}

async function getCoords(city) {
    const lower = city.toLowerCase().trim();

    // Check hardcoded cities first (fast path, read-only allow-list)
    if (CITIES[lower]) {
        console.log(`[GEOCODE] Found in cache: ${city}`);
        return CITIES[lower];
    }

    // Then the ephemeral runtime cache (Fix A-CF3 — never poisons CITIES)
    if (GEOCODE_CACHE.has(lower)) {
        console.log(`[GEOCODE] Found in runtime cache: ${city}`);
        return GEOCODE_CACHE.get(lower);
    }

    // Check for direct coordinates (lat,lon format)
    if (city.includes(',')) {
        const parts = city.split(',').map(s => parseFloat(s.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            const [lat, lon] = parts;
            // Validate reasonable coordinate ranges
            if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                console.log(`[GEOCODE] Direct coordinates: ${lat}, ${lon}`);
                return { lat, lon };
            }
        }
    }

    // UNIVERSAL GEOCODING: Works anywhere in the world
    // Uses OpenStreetMap Nominatim for free geocoding
    console.log(`[GEOCODE] Looking up: ${city}`);

    try {
        // First try: search globally without country restriction
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&addressdetails=1&limit=10`,
            {
                // AS-03 FIX (2026-06-10): the custom User-Agent header was
                // removed — UA is a forbidden header for browser fetch();
                // Chrome silently dropped it and sent the browser UA anyway,
                // so it only SIMULATED Nominatim-policy compliance. Real
                // mitigation is the call pattern itself: single request per
                // search start, 13-city hardcoded allow-list fast path,
                // runtime cache, "lat,lon" bypass, concurrent starts blocked.
                headers: {
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            }
        );

        if (!resp.ok) {
            throw new Error(`Geocoding API error: ${resp.status}`);
        }

        const data = await resp.json();

        // Rank-preserving, settlement-preferring selection (Fix A): never blindly
        // take data[0] — for a provincial capital the province boundary outranks
        // the city node by importance and its centroid is tens of km off-target.
        const chosen = selectGeocodeResult(data);
        if (chosen) {
            const result = {
                lat: parseFloat(chosen.lat),
                lon: parseFloat(chosen.lon)
            };
            console.log(`[GEOCODE] ✓ Found: ${city} → ${result.lat.toFixed(4)}, ${result.lon.toFixed(4)} (${chosen.addresstype}/${chosen.class}; ${chosen.display_name})`);

            // Cache in the ephemeral runtime map — NOT in the curated CITIES table.
            GEOCODE_CACHE.set(lower, result);

            return result;
        }

        console.warn(`[GEOCODE] No results for: ${city}`);
        return null;

    } catch (e) {
        console.error(`[GEOCODE] Error looking up ${city}:`, e.message);
        return null;
    }
}

function generateGrid(lat, lon, radiusKm, spacingKm) {
    // =====================================================
    // OPTIMAL HEXAGONAL GRID - Reduces overlapping searches
    // =====================================================
    // Uses hex packing for ~75% reduction in grid points
    // while maintaining same coverage

    // Use optimal spacing for hex packing
    const optimalSpacing = Math.max(spacingKm, GRID_OPTIMIZER.MIN_OPTIMAL_SPACING);
    const rowHeight = optimalSpacing * Math.sqrt(3) / 2;
    const points = [];

    // Generate hexagonal grid
    for (let y = -radiusKm; y <= radiusKm; y += rowHeight) {
        const rowIndex = Math.round(y / rowHeight);
        const xOffset = (rowIndex % 2) * (optimalSpacing / 2);

        for (let x = -radiusKm; x <= radiusKm; x += optimalSpacing) {
            const px = x + xOffset;

            // STRICT OUTER BOUNDS: the entire tile (center + ~4 km radius)
            // must fit inside the user-selected disc. Prevents perimeter overflow.
            const dist = Math.sqrt(px * px + y * y);
            const tileRadius = GRID_OPTIMIZER.GOOGLE_EFFECTIVE_RADIUS_KM;
            if (dist + tileRadius <= radiusKm) {
                const point = destPoint(lat, lon,
                    Math.atan2(px, y) * 180 / Math.PI,
                    dist
                );
                points.push(point);
            }
        }
    }

    // Failsafe: if strict bounds rejected every candidate (e.g. spacing too
    // coarse for the radius), emit the origin so the search still runs.
    if (points.length === 0) {
        console.warn(`[GRID_OPTIMIZER] No valid centers for r=${radiusKm}, s=${spacingKm}, tile=${GRID_OPTIMIZER.GOOGLE_EFFECTIVE_RADIUS_KM}. Emitting origin.`);
        points.push(destPoint(lat, lon, 0, 0));
    }

    // Calculate comparison with old algorithm for logging
    const oldEstimate = Math.floor(Math.PI * Math.pow(radiusKm / spacingKm, 2));
    console.log(`[GRID_OPTIMIZER] Generated ${points.length} hex-packed points (vs ~${oldEstimate} with old algorithm)`);

    return HumanBehavior.shuffle(points);
}

function destPoint(lat, lon, bearing, distKm) {
    const R = 6371;
    const d = distKm / R;
    const b = bearing * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
    const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

    return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Control
// AS-02 FIX (2026-06-10): state-machine guard — pause/resume are only valid
// transitions while a run is active. At idle they used to mutate isPaused and
// fire a spurious progress broadcast (the NaN-percent path). The only UI
// consumer (area-search-modal handlePause) ignores the response shape, so the
// early-return is contract-safe.
function pauseTurbo() {
    if (!TURBO_STATE.isRunning) return { status: 'idle' };
    TURBO_STATE.isPaused = true; broadcastProgress(); return { status: 'paused' };
}
function resumeTurbo() {
    if (!TURBO_STATE.isRunning) return { status: 'idle' };
    TURBO_STATE.isPaused = false; broadcastProgress(); return { status: 'resumed' };
}

/**
 * AS-01 FIX (2026-06-10): close every window/tab this extension created and
 * still tracks — the in-memory `openTabs` Set AND the session-storage
 * marker-based ledger (B3-3). Extracted from stopTurbo so ALL lifecycle
 * boundaries share the same idempotent, mutex-protected sweep:
 *   • stopTurbo            — user-initiated stop (pre-existing behavior)
 *   • eviction respawn     — popups of the interrupted batch are by definition
 *                            orphans (the loop that owned them died with the
 *                            SW); close them BEFORE the redo creates new ones
 *   • finishTurbo          — natural completion sweeps any leftovers before
 *                            resetTurboState() wipes openTabs (which would
 *                            lose the IDs forever — the pre-fix bug)
 * Idempotent: per-window try/catch, ledger no-op when empty (the common case).
 *
 * NOTE (deliberate non-fix): the interrupted batch is REDONE, not skipped —
 * `currentBatch` only advances in the batch `finally`, and the CID-keyed
 * fill-holes merge makes the redo idempotent on data. A persisted
 * "batch-in-progress skip" marker would trade correctness (losing the
 * un-extracted tail of that batch) for speed on a rare event. The window
 * ledger already persists everything needed to undo the visible damage.
 *
 * @param {string} label - log prefix identifying the calling boundary
 * @returns {Promise<void>}
 */
async function _closeOrphanWindows(label) {
    await tabCleanupMutex.runExclusive(async () => {
        // STEP 1: Close tracked tabs first (fast path)
        if (TURBO_STATE.openTabs.size > 0) {
            console.log(`[${label}] 🧹 Closing ${TURBO_STATE.openTabs.size} tracked tabs`);
            for (const tabId of TURBO_STATE.openTabs) {
                try {
                    await chrome.tabs.remove(tabId);
                } catch (e) {
                    // Tab may have been closed already
                }
            }
            TURBO_STATE.openTabs.clear();
            _schedulePersist();  // B3-1: Set mutation doesn't trigger Proxy set; persist explicitly
        }

        // STEP 2: Marker-based fallback (B3-3 P0 fix)
        // ─────────────────────────────────────────────────────────────────────
        // Read the session-storage ledger of windows WE created and tagged
        // with our session marker. Close ONLY those — never the user's own
        // Maps tabs. If the ledger is empty, do nothing (safer than
        // overreaching; see B3-3 history for the chrome.tabs.query({}) abuse).
        try {
            const trackedIds = await _getTrackedWindowIds();
            if (trackedIds.length > 0) {
                console.log(`[${label}] 🧹 Closing ${trackedIds.length} marker-tracked windows (NOT user tabs)`);
                for (const wId of trackedIds) {
                    try {
                        await chrome.windows.remove(wId);
                    } catch (e) {
                        // Window may already be closed; logging only
                        const msg = e instanceof Error ? e.message : String(e);
                        console.warn(`[CLEANUP] Failed to close window ${wId}:`, msg);
                    }
                }
                // Wipe the ledger — all our tracked windows are now closed (or gone)
                try { await chrome.storage.session.remove(_TRACKED_WINDOWS_KEY); } catch (_) { /* ignore */ }
                console.log(`[${label}] ✓ Tracked-window cleanup complete`);
            } else {
                console.log(`[${label}] No tracked windows in ledger — sweep no-op (user tabs preserved)`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[${label}] Marker-based cleanup failed:`, msg);
        }
    });
}

async function stopTurbo() {
    TURBO_STATE.isRunning = false;

    // F-03: wait for the run loop's in-progress batch finally to complete
    //       BEFORE we tear down state. Without this, resetTurboState races
    //       with the batch finally and corrupts stats; cleanupTabs fires
    //       twice and emits "No tab with id" warnings. Sentinel approach
    //       (NOT a sleep) — completion-driven, zero extra latency.
    const sentinel = _runLoopSentinel;
    if (sentinel) {
        await sentinel.promise;
    }

    // BGW-H3 FIX: Mutex-protected tab cleanup to prevent race conditions
    // AS-01: shared sweep helper (was inlined here pre-fix; behavior identical)
    await _closeOrphanWindows('BGW-H3');

    // FIX H-002: Clear all area-search owned timers to prevent memory leaks
    const timerRegistry = getTimerRegistry();
    const clearedTimers = timerRegistry.clearByOwner('area-search');
    console.log(`[TURBO] Cleared ${clearedTimers} area-search timers`);

    resetTurboState(); // CRITICAL: Clear memory on stop
    return { status: 'stopped', cleanedUp: true };
}
function getTurboStatus() { return { isRunning: TURBO_STATE.isRunning, isPaused: TURBO_STATE.isPaused, stats: TURBO_STATE.stats }; }

// =====================================================
// MESSAGE HANDLERS
// =====================================================

/*
Add to background/index.js:

            case 'start_area_search':
                return await startTurboV3(payload);

            case 'pause_area_search':
                return pauseTurbo();

            case 'resume_area_search':
                return resumeTurbo();

            case 'stop_area_search':
                return await stopTurbo();

            case 'get_area_search_status':
                return getTurboStatus();
*/

// =====================================================
// EXPORTS
// =====================================================

export { startTurboV3, pauseTurbo, resumeTurbo, stopTurbo, getTurboStatus, setSaveHandler };
// v9.11: Exported for unit tests in tests/area_search_detail_drain.test.js.
// These are NOT part of the public API — internal helpers used by runTurboV3.
export { _wakeObserversInTabs, _waitForDetailFetcherIdle, _collectDetailFetcherStats };
// AS-01 (2026-06-10): exported for tests/run-area-search-orphan-cleanup-as01-node.mjs.
// Internal lifecycle-boundary sweep — NOT public API.
export { _closeOrphanWindows };
// fix-area-search-wrong-center (01-01): pure, rank-preserving Nominatim
// settlement selection. Exported for tests/run-area-search-geocode-node.mjs.
export { selectGeocodeResult };
export default { start: startTurboV3, pause: pauseTurbo, resume: resumeTurbo, stop: stopTurbo, status: getTurboStatus, setSaveHandler };

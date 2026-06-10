/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro v9.0.1 - Background Service Worker
 * Refactored with proper error handling, retry logic, and robustness
 * AUDIT FIXES: Phase 1 + Phase 2 applied (P1-001/002/004, P2-010/011)
 */

import { CONFIG } from '../lib/config.js';
import {
    initDB,
    saveBusiness,
    getBusiness,
    getBusinesses,
    getBusinessesForEmailScraping,
    getBusinessesWithoutWebsite,
    getFailedBusinesses,  // P3-002 FIX: Added for retry functionality
    updateBusiness,
    getStats,
    clearAllBusinesses,
    deleteBusiness,  // BROKEN CODE FIX: Added for storage-modal delete functionality
    // B10-3 FIX (2026-05-10): server-side filter helpers for storage-modal
    // cleanup. Avoids fetching full business records over IPC.
    getOldEmailedBusinessIds,
    getOldBusinessIds
} from '../lib/db.js';
import { sitemapDiscovery } from '../lib/SitemapDiscovery.js';
import { normalizeGoogleMapsUrl, getCanonicalDbKey } from '../lib/urlNormalizer.js';
import { enrichmentRetryQueue } from '../lib/enrichmentRetryQueue.js';
// SAVE-DLQ (2026-05-28): dead-letter recovery for save failures that survive the
// in-process retry in db.saveBusiness. See docs/feature/fix-area-search-save-error-swallow/rca.md.
import { enqueueDeadLetter, drainDeadLetter, getDeadLetterCount } from '../lib/saveDeadLetter.js';
import { extractPartitaIva } from '../lib/partitaIva.js';
import { syncToOpportuni } from '../lib/opportuni-auth.js';
import {
    logger,
    retry,
    sleep,
    escapeCsv,
    getDomain
} from '../lib/utils.js';
import { JobQueue } from './jobQueue.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import {
    isValidScrapableUrl,
    scrapeEmailForBusiness as scrapeEmailForBusinessModule,
    fetchWebsiteHTML,
    parseHTMLInOffscreen as parseHTMLInOffscreenModule
} from './email-scraper-v2.js';
import {
    exportData as exportDataModule,
    exportEmailsMarkdown as exportEmailsMarkdownModule,
    exportUrls as exportUrlsModule
} from './data-exporter.js';
import {
    setupOffscreenDocument as setupOffscreenDocumentModule,
    ensureOffscreenReady as ensureOffscreenReadyModule
} from './offscreen-manager.js';
import AreaSearch from './area-search.js';
import {
    extractMissingWebsites,
    pauseWebsiteExtraction,
    resumeWebsiteExtraction,
    stopWebsiteExtraction,
    getWebsiteExtractionStatus
} from './website-extractor.js';
import {
    ExportAPI,
    cleanupInvalidWebhooks,
    API_MESSAGE_TYPES
} from '../lib/ExportAPI.js';
// BUG-016 FIX: Import reset functions for factory reset
// CRAWLEE FEATURE 1.1: Import getStatistics for retry histogram
// CRAWLEE PHASE 2.2: Import initializeSessionPool for persistence
import { resetStatistics, getStatistics, setSessionPoolForStats } from '../lib/Statistics.js';
import { resetSessionPool, initializeSessionPool, shutdownSessionPool } from '../lib/SessionPool.js';

// v9.12 Wave 1: detail-fetch enrichment telemetry. Counts hit/miss for
// PROVISIONAL parsers (currently: hours). Surfaced via getEnrichmentTelemetry()
// for smoke-run inspection and future UI.
const enrichmentTelemetry = {
    hoursFound: 0,           // hoursRaw was non-null in incoming fields
    hoursMissing: 0,         // hoursRaw was null/absent
    hoursDaysFoundSum: 0     // sum of daysFound across hits (avg = sum/hoursFound)
};
export function getEnrichmentTelemetry() {
    return { ...enrichmentTelemetry };
}

// CRAWLEE PHASE 3: System Monitor and AutoScaler
import { initializeSystemMonitor, stopSystemMonitor, getSystemMonitor } from '../lib/SystemMonitor.js';
import { getAutoScaler } from '../lib/AutoScaler.js';
import { container } from '../lib/ServiceContainer.js';
import { robotsCompliance } from '../lib/RobotsCompliance.js';
import { validateMessageSender } from './message-validator.js';
// Step 03-03: Safe merge to prevent prototype pollution on selector config
import { safeMerge, fillHolesMerge } from '../lib/sanitize.js';
// Step 03-04: Coordinated infrastructure shutdown
import { shutdownInfrastructure } from '../lib/infrastructure.js';
// DEBT-3 (2026-05-27): `circuitBreaker` is now an explicit frozen
// namespace export from CircuitBreaker.js (Object.freeze({ ...public fns })).
// The pre-DEBT-3 trap — exported Map with the same name — is renamed to
// `_circuitBreakerStateMap`. The wide `import * as` is no longer needed:
// the named import gets the same API surface with intent expressed.
import { circuitBreaker } from '../lib/CircuitBreaker.js';
import { createSessionState } from '../lib/swState.js';

// 2026-05-15: dev log bridge. When loaded as unpacked (CONFIG.isDevelopment
// derived from `!manifest.update_url`), every console.* + unhandled error +
// unhandled rejection is forwarded to http://127.0.0.1:9876/log so the
// operator (and a connected coding agent watching the file) can see the
// SW's under-the-hood activity without keeping the SW DevTools window
// pinned. No-op in production. See dev-log-server.mjs + lib/devLogger.js.
import { installDevLogger } from '../lib/devLogger.js';
if (CONFIG.isDevelopment) {
    installDevLogger('SW');
}


// ... (rest of file)



// =====================================================
// SERVICE WORKER ENTRY POINT - DEFENSIVE INITIALIZATION
// =====================================================

/**
 * SECURITY: Verify chrome.tabs API availability
 * The error "Cannot read properties of undefined (reading 'onUpdated')" 
 * suggests chrome.tabs might be undefined in some contexts.
 * This defensive check ensures we catch this early.
 */
if (!chrome || !chrome.tabs) {
    console.error('[CRITICAL] chrome.tabs API not available in service worker context!');
    console.error('[CRITICAL] This should never happen in Manifest V3.');
    console.error('[CRITICAL] Check manifest.json permissions: "tabs" must be declared.');
} else {
    logger.info('[SECURITY CHECK] ✓ chrome.tabs API verified available');
}

/**
 * SECURITY: Global error handler for unhandled errors
 * Catches any errors that slip through try-catch blocks
 * Critical for diagnosing intermittent issues like the onUpdated error
 */
self.addEventListener('error', (event) => {
    console.error('[GLOBAL ERROR HANDLER]', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
    });

    // Special handling for onUpdated errors
    if (event.message && event.message.includes('onUpdated')) {
        console.error('[CRITICAL] onUpdated error detected!');
        console.error('[DIAGNOSTICS] chrome.tabs available:', !!chrome?.tabs);
        console.error('[DIAGNOSTICS] chrome.tabs.onUpdated available:', !!chrome?.tabs?.onUpdated);
    }
});

/**
 * SECURITY: Global unhandled rejection handler
 * Catches promise rejections that don't have .catch() handlers
 */
self.addEventListener('unhandledrejection', (event) => {
    console.error('[UNHANDLED REJECTION]', {
        reason: event.reason,
        promise: event.promise
    });
});

logger.info('Service Worker Starting... [PRIORITY_FIX_V1]');
logger.info('[SECURITY] Defensive error handlers installed');
logger.info('[SERVICE WORKER] Initialization sequence beginning...');

// Initialize Job Queue and Performance Monitor
const jobQueue = new JobQueue();
const performanceMonitor = new PerformanceMonitor();

// 2026-05-15 FIX (closure-jobs not persistable):
// pre-fix `addEmailJob` and the retry-failed call site used
// `jobQueue.add(async () => scrapeEmailForBusiness(b))` — a closure.
// JobQueue marks closure jobs as `persistable=false` (see comment at
// jobQueue.js:1156, "Closure jobs ... remain a B6-2 (P1) concern")
// because it cannot serialize a closure. Net effect: saveQueue() always
// wrote ZERO jobs to chrome.storage. After SW eviction the restored
// queue was always empty → no auto-resume could happen, scrape froze
// at N/M forever. Observed today at 17/40 (42%) and 15/40 (38%) on
// consecutive 40-business runs.
//
// Fix: register an 'email_scrape' typed job, persist only the
// canonical DB key (small + stable across schema drift), and have the
// factory re-fetch the fresh business from IndexedDB on restore.
// If the business was deleted between eviction and restore, factory
// returns null (job becomes a no-op) instead of crashing on a stale
// snapshot.
jobQueue.registerJobType('email_scrape', (params) => async () => {
    const key = params?.canonicalUrl;
    if (!key) {
        logger.warn('[JobQueue] email_scrape: missing canonicalUrl in params, skipping');
        return null;
    }
    const fresh = await getBusiness(key);
    if (!fresh) {
        logger.debug(`[JobQueue] email_scrape: business no longer in DB (deleted between eviction and restore): ${key}`);
        return null;
    }
    return await scrapeEmailForBusiness(fresh);
});

// Track offscreen document state
let offscreenCreating = null;

// PHASE 3 FIX #24: Progress tracking
//
// BG-4 FIX (2026-05-10): persist these counters across SW eviction so
// the sidepanel doesn't reset to 0/0 mid-batch when Chrome reclaims the
// SW after its idle window. In-memory remains source of truth during
// normal operation (sync reads in tight loops); a debounced write-
// through ships changes to chrome.storage.session, and a one-shot
// restore on boot rehydrates the in-memory copy.
const _emailProgressState = createSessionState('email_progress.v1', { total: 0, completed: 0 });
let _emailProgressPersistTimer = null;
let _emailProgressRestored = false;

function _schedulePersistEmailProgress() {
    if (_emailProgressPersistTimer) clearTimeout(_emailProgressPersistTimer);
    _emailProgressPersistTimer = setTimeout(async () => {
        _emailProgressPersistTimer = null;
        try {
            await _emailProgressState.set({
                total: totalEmailJobs,
                completed: completedEmailJobs,
            });
        } catch (e) {
            // SW eviction during the debounce window can drop the latest
            // mutation (single counter-write loss) — that is acceptable
            // for a display field.
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug(`[BG-4] persist email progress failed: ${msg}`);
        }
    }, 200);
}

async function _restoreEmailProgressOnce() {
    if (_emailProgressRestored) return;
    _emailProgressRestored = true;
    try {
        const snap = await _emailProgressState.get();
        if (snap && typeof snap === 'object') {
            if (typeof snap.total === 'number' && Number.isFinite(snap.total)) {
                totalEmailJobs = snap.total;
            }
            if (typeof snap.completed === 'number' && Number.isFinite(snap.completed)) {
                completedEmailJobs = snap.completed;
            }
        }
    } catch {
        // First boot or storage error — keep defaults of 0/0.
    }
}
let totalEmailJobs = 0;
let completedEmailJobs = 0;
// Fire the restore at module load AFTER the let bindings exist (TDZ-safe).
// The async function returns a Promise that we don't await here because
// background.js boot is sync-style. Any reader before restore finishes
// sees 0/0 (acceptable; restore is ~ms).
_restoreEmailProgressOnce();

// BG-5 FIX (2026-05-10): pre-fix `currentBusinessName` was a single
// module-scope string overwritten by every concurrent worker in
// scrapeEmailForBusiness. With AutoScaler running 5 workers, the broadcast
// progress event always showed the name of the worker that wrote LAST,
// not the one that just completed — the UI displayed a name unrelated to
// the actual work that triggered the broadcast.
//
// Now: keyed Map<googleMapsUrl, name> of in-flight scrape targets.
// scrapeEmailForBusiness sets on entry and clears in `finally`.
// Broadcast uses `_currentBusinessNamesDisplay()` which joins up to 2
// names + "+N more" for the visible UI string.
const _activeBusinessNames = new Map();   // url → human-readable title
function _setCurrentBusinessName(url, name) {
    if (!url) return;
    _activeBusinessNames.set(url, name || 'Unknown');
}
function _clearCurrentBusinessName(url) {
    if (!url) return;
    _activeBusinessNames.delete(url);
}
function _currentBusinessNamesDisplay() {
    const names = Array.from(_activeBusinessNames.values());
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} + 1 more`;
    return `${names[0]} + ${names.length - 1} more`;
}
// Legacy alias kept for code paths that read the string directly (e.g.
// pre-fix passed `currentBusinessName` into scrapeEmailForBusinessModule
// as a label). We use the display function value so the legacy reader
// still gets a sensible string.
let currentBusinessName = '';

/**
 * Initialize on startup
 */
async function initialize() {
    try {
        await initDB();
        logger.info('Database initialized successfully');

        await loadSettings();
        logger.info('Settings loaded successfully');

        // BUG-1 NEW-2 (PR #73): retroactive cleanup of webhooks registered
        // under the pre-fix isPrivateOrSpecialAddr that allowed IPv4-mapped
        // IPv6 SSRF (::ffff:127.0.0.1, NAT64, 6to4, Teredo, etc.). Webhooks
        // persisted in chrome.storage.local remain armed across SW evictions
        // and survive the deploy of the fix. cleanupInvalidWebhooks() filters
        // stored webhooks through the current (hardened) isValidWebhookUrl
        // and removes any that no longer pass. Idempotent — safe to run at
        // every SW init. Layer 2 (fire-time guard in triggerWebhooks)
        // remains as defense-in-depth.
        try {
            const result = await cleanupInvalidWebhooks();
            if (result && result.removed && result.removed.length > 0) {
                logger.warn(`[BUG-1 NEW-2] Cleaned up ${result.removed.length} pre-fix webhook(s) (kept ${result.kept})`);
            }
        } catch (e) {
            logger.error('[BUG-1 NEW-2] cleanupInvalidWebhooks failed:', e);
        }

        // M8-CONFLICT FIX: Centralized authoritative SessionPool config
        // This is the SINGLE SOURCE OF TRUTH for SessionPool configuration.
        // All other modules (email-scraper-v2.js, area-search.js) must call
        // getSessionPool() WITHOUT config options. Conflicting values will
        // trigger a warning and be ignored.
        const sessionPool = await initializeSessionPool({
            maxPoolSize: 20,
            maxUsageCount: 30,
            maxErrorScore: 5,           // Authoritative: 5 (not 3 from area-search)
            maxAgeSecs: 1800,           // 30 minutes
            // B11-6 #3 hardening: 60s → 30s. SW eviction can land between
            // auto-persist ticks; tighter cadence narrows the worst-case
            // loss window for cookies / usageCount / errorScore. Storage
            // write rate ~10 KB / 30s = trivial. Underlying eviction-safety
            // is already provided by chrome.storage.local (persistent) +
            // restore() at initializeSessionPool() boot.
            autoPersistIntervalMs: 30000,
            restoreFromStorage: true       // Restore from previous session
        });
        container.register('sessionPool', sessionPool); // DI Registration
        logger.info('SessionPool initialized and registered in container');

        // B4-1 fix: Statistics also wired here so email-scraper-v2.js _getStats()
        // can resolve via container instead of eager-init at module load.
        // setSessionPoolForStats wires Statistics → SessionPool integration.
        const statistics = getStatistics({ logIntervalSecs: 120 });
        setSessionPoolForStats(sessionPool);
        container.register('statistics', statistics);
        logger.info('Statistics initialized + SessionPool wired + DI registered');

        // CRAWLEE PHASE 3.1: Initialize System Monitor
        await initializeSystemMonitor({
            snapshotIntervalMs: 5000,      // Every 5 seconds
            memoryWarningRatio: 0.8,       // Warn at 80% memory
            memoryCriticalRatio: 0.9,      // Critical at 90%
            onWarning: (snapshot, issues) => {
                logger.warn(`[SystemMonitor] ⚠️ System warning: ${issues.join(', ')}`);
            },
            onCritical: (snapshot, issues) => {
                logger.error(`[SystemMonitor] 🚨 System critical: ${issues.join(', ')}`);
                // Reduce concurrency on critical
                const autoScaler = getAutoScaler();
                autoScaler.setConcurrency(1);
            }
        });
        logger.info('SystemMonitor started');

        // M8-CONFLICT FIX: Centralized authoritative AutoScaler config
        // This is the SINGLE SOURCE OF TRUTH for AutoScaler configuration.
        // All other modules (jobQueue.js, email-scraper-v2.js) must call
        // getAutoScaler() WITHOUT config options. Conflicting values
        // (e.g., jobQueue min:2/max:8) will trigger a warning and be ignored.
        const autoScaler = getAutoScaler({
            minConcurrency: 1,
            maxConcurrency: CONFIG.rateLimits.emailScraping.maxConcurrent || 5,
            desiredConcurrency: 3,
            successRateThresholdUp: 0.85,
            successRateThresholdDown: 0.6
        });
        logger.info(`AutoScaler initialized: ${autoScaler.toString()}`);

        // CRAWLEE PHASE 3.3: Initialize JobQueue with persistence
        // B6-3: 30000 → 10000. chrome.runtime.onSuspend is "best effort" in
        // MV3 (Chrome may evict without firing it), so auto-save interval
        // bounds the worst-case in-flight loss. 10 s × ~5KB jobs ≈ 30KB/min
        // storage write — negligible. Hardening, no measured production loss.
        const _restoredJobCount = await jobQueue.initialize({
            autoSaveIntervalMs: 10000,
            loadFromStorage: true
        });

        // 2026-05-15: AUTO-RESUME after SW eviction.
        // Pre-fix: B6-1/BG-7 persisted the queue across eviction, but
        // `initialize()` only restored the data — it never called start()
        // to actually process the restored jobs. Result: after the SW
        // crashed/eviction mid-scrape, the queue rehydrated as "idle".
        // The UI still showed "Extracting…" (its own persisted state) and
        // the user saw progress stuck at N/M forever (e.g. 15/40 → 38%).
        // Observed today on a 40-business run.
        //
        // Heuristic: if there are jobs in the persisted queue, the previous
        // SW lifetime was in an active scrape — auto-resume. Safe because
        // saveQueue() only writes when there are pending/in-flight jobs;
        // a "stopped" scrape leaves an empty queue. Errors swallowed so
        // a failed start() doesn't break SW init.
        if (_restoredJobCount > 0) {
            try {
                logger.info(`[JobQueue] 🔁 Auto-resuming ${_restoredJobCount} restored job(s) after SW boot`);
                jobQueue.start();
            } catch (resumeErr) {
                logger.warn('[JobQueue] auto-resume failed:', resumeErr?.message || resumeErr);
            }
        }
        logger.info('JobQueue persistence enabled');

        // Setup queue callbacks
        setupQueueCallbacks();

        // DI Registration
        container.register('jobQueue', jobQueue);
        container.register('performanceMonitor', performanceMonitor);
        container.register('autoScaler', autoScaler);
        container.register('systemMonitor', getSystemMonitor());
        container.register('robotsCompliance', robotsCompliance);

        logger.info('All core services registered in ServiceContainer');

    } catch (error) {
        logger.error('Initialization failed:', error);
        // B1-3 fix: was setTimeout(initialize, 5000), but the timer ID lives
        // on the SW event loop and dies if the SW is evicted before it fires
        // (~30s idle). The retry then never happens — recovery defers to
        // whatever event next wakes the SW (could be hours).
        // chrome.alarms persist across eviction and fire deterministically.
        try {
            chrome.alarms.create('gmp-init-retry', { delayInMinutes: 0.5 });
        } catch (alarmErr) {
            // If chrome.alarms is unavailable (test harness, etc.), fall back
            // to setTimeout — the retry-on-eviction case is then unprotected
            // but the synchronous retry path still works.
            setTimeout(initialize, 5000);
        }
    }
}

// B1-3: alarm-driven init retry handler. Registered top-level alongside the
// existing keepalive alarm handler so it survives eviction.
chrome.alarms?.onAlarm?.addListener?.((alarm) => {
    if (alarm.name === 'gmp-init-retry') {
        chrome.alarms.clear('gmp-init-retry').catch(() => {});
        try { logger.info('[INIT] Retry alarm fired, re-attempting initialize()'); } catch {}
        initialize();
    }
});

// B1-4: onStartup listener — fires once when Chrome itself starts up.
// In MV3 the SW boots automatically on browser launch only if there's an
// outstanding event; otherwise the extension stays cold until the user
// interacts. This listener gives us a deterministic hook for pre-warm
// work (cache fill, healthchecks). Body is intentionally minimal — extend
// when pre-warm work surfaces.
chrome.runtime?.onStartup?.addListener?.(() => {
    try {
        logger.info('[STARTUP] Browser launched — SW pre-warm hook fired');
    } catch (_) { /* logger may not be ready in extreme cold-start */ }
});

// ═══════════════════════════════════════════════════════════════════════════
// B1-2 P0 FIX: top-level await + init-gate for handleMessage
// ─────────────────────────────────────────────────────────────────────────
// Pre-fix: `initialize();` was fire-and-forget. The
// chrome.runtime.onMessage listener (registered at module load) could
// receive messages BEFORE init completed — racing with jobQueue callbacks
// (registered async inside initialize()), sessionPool restore, etc.
// Symptom: progress events lost, state corruption on burst start.
//
// Fix (defense in depth):
//   1. Top-level `await initialize()` — Chrome MV3 modules support top-level
//      await (Chrome 91+, manifest_version 3 requires Chrome 88+ so this is
//      safe). If init throws, modulo loads anyway (try/catch); listeners
//      are still registered, init retried via setTimeout.
//   2. `_initialized` flag + gate in handleMessage — even if a message
//      arrives before top-level await completes (theoretical race), the
//      handler waits for init. Belt-and-suspenders.
//
// Note: the bare `initialize();` from the wave-8 cleanup batch is intentionally
// dropped here — B1-2 calls initialize() via the tracked _initializePromise
// + top-level-await path below. A second fire-and-forget call would race.
//
// Reference: docs/HANDOFF_ULTRAREVIEW_BLOCKS.md Block 1 §B1-2
// ═══════════════════════════════════════════════════════════════════════════

let _initialized = false;
let _initializePromise = null;

/**
 * Wait for initialize() to complete. Used by handleMessage as a defense-
 * in-depth gate against any messages that slip in before top-level await
 * completes.
 *
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<boolean>} true if init completed in time, false on timeout
 */
async function _waitForInit(timeoutMs = 10000) {
    if (_initialized) return true;
    if (_initializePromise) {
        try {
            await Promise.race([
                _initializePromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('INIT_WAIT_TIMEOUT')), timeoutMs))
            ]);
            return _initialized;
        } catch (e) {
            return false;
        }
    }
    return false;
}

// Track the init promise so _waitForInit can await it.
//
// 2026-05-15 REVERT: removed top-level `await _initializePromise` from the
// original B1-2 fix — Chrome (current stable) rejects MV3 service workers
// containing top-level await with the manifest-level error "Top-level
// await is disallowed in service workers", causing the SW to fail
// registration entirely (Status code: 3). The defense-in-depth gate is
// already provided by _waitForInit() in handleMessage; the top-level
// await was redundant. Fire-and-forget keeps the gate while restoring
// SW registration.
_initializePromise = initialize().then(
    () => { _initialized = true; },
    (err) => {
        logger.error('[INIT] Initialize rejected:', err);
        // Don't propagate — the modulo must still load so listeners stay
        // registered. Retry path inside initialize() will re-attempt.
    }
);

// Inject dependencies (unchanged — runs after init)
AreaSearch.setSaveHandler(handleBusinessBatch);

/**
 * Load settings from storage
 */
async function loadSettings() {
    try {
        const { userSettings } = await chrome.storage.local.get(['userSettings']);

        if (userSettings && jobQueue) {
            // Apply settings to job queue
            if (userSettings.maxConcurrent) jobQueue.maxConcurrent = userSettings.maxConcurrent;

            // Update rate limiting (approximate since we use Gaussian)
            if (userSettings.rateLimit) {
                // Convert req/min to mean delay in ms
                // 60000ms / rateLimit = meanDelay
                jobQueue.meanDelayMs = 60000 / userSettings.rateLimit;
                // Adjust jitter to be 25% of mean delay
                jobQueue.jitterStdDev = jobQueue.meanDelayMs * 0.25;
            }

            logger.info(`Settings loaded: ${JSON.stringify(userSettings)}`);
        }
    } catch (error) {
        logger.error('Failed to load settings:', error);
    }
}

/**
 * Setup job queue callbacks
 * PHASE 3 FIX #24: Added progress broadcasting
 */
function setupQueueCallbacks() {
    jobQueue.onQueueEmpty = () => {
        logger.info('All email scraping jobs completed');
        stopKeepAlive(); // Stop keepalive when queue empty
        _stopPhase2Heartbeat();  // UX-1: stop progress heartbeat
        broadcastMessage({
            action: 'email_scraping_finished',
            payload: { stats: jobQueue.getStatus() }
        });
    };

    jobQueue.onJobComplete = (job, result) => {
        logger.debug('Job completed:', job.id);

        // CRAWLEE FEATURE 1.1: Record retry success in histogram
        const statistics = getStatistics();
        statistics.recordRetrySuccess(job.retries || 0);

        // Record performance metrics
        const duration = result?.duration || 0;
        performanceMonitor.recordJob(duration, true);

        // PHASE 3 FIX #24: Update progress tracking
        completedEmailJobs++;
        _schedulePersistEmailProgress();  // BG-4: persist for SW-eviction restore

        // Broadcast progress update
        // BG-5: use the multi-name display function so concurrent workers
        // are aggregated into one truthful UI string.
        broadcastMessage({
            action: 'scraping_progress',
            payload: {
                current: completedEmailJobs,
                total: totalEmailJobs,
                currentItem: _currentBusinessNamesDisplay()
            }
        });
    };

    jobQueue.onJobFailed = (job, error) => {
        logger.error('Job failed permanently:', job.id, error.message);

        // Record failure metrics
        performanceMonitor.recordJob(0, false);
        performanceMonitor.recordError(error.message || 'unknown');
    };
}

/**
 * Listen for installation and updates
 * SECURITY FIX: Disable navigation preload to prevent warnings
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    // SECURITY FIX: Disable navigation preload if supported
    // This prevents "service worker navigation preload request was cancelled" warnings
    // Navigation preload is a performance feature for page navigations, but we don't use it
    // in this extension (we only use service worker for background tasks)
    try {
        // Type guard: Check if we're in ServiceWorkerGlobalScope
        // @ts-ignore - Type checking for registration in ServiceWorkerGlobalScope
        const registration = (typeof self !== 'undefined' && 'registration' in self)
            ? self.registration
            : null;

        // @ts-ignore - navigationPreload exists on ServiceWorkerRegistration
        if (registration && typeof registration.navigationPreload !== 'undefined') {
            // @ts-ignore - disable() method exists on NavigationPreloadManager
            await registration.navigationPreload.disable();
            logger.info('[SECURITY] Navigation preload disabled successfully');
        } else {
            logger.debug('[SECURITY] Navigation preload not supported in this context');
        }
    } catch (error) {
        // Non-critical error - log but continue
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('[SECURITY] Could not disable navigation preload:', errorMessage);
    }

    // Handle installation and updates
    if (details.reason === 'install') {
        logger.info('[INSTALL] Extension installed - opening welcome page');
        chrome.tabs.create({ url: 'ui/welcome.html' }).catch(err => {
            logger.warn('Could not open welcome page:', err);
        });
    } else if (details.reason === 'update') {
        const version = chrome.runtime.getManifest().version;
        logger.info(`[UPDATE] Extension updated to v${version}`);
    }
});

/**
 * Message Listener with comprehensive error handling
 * P0-002 FIX: Added timeout guard to prevent calling sendResponse on closed channel
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // P0-002 FIX: Track if response was already sent to prevent double-send
    let responseSent = false;

    // P0-002 FIX: Timeout guard - Chrome closes channel after ~30s
    const channelTimeout = setTimeout(() => {
        if (!responseSent) {
            responseSent = true;
            logger.warn('[MSG] Message channel timeout - handler still processing:', message.action);
            sendResponse({ status: 'timeout', error: 'Handler timeout after 25s' });
        }
    }, 25000);

    // Handle message asynchronously
    handleMessage(message, sender)
        .then(response => {
            if (!responseSent) {
                responseSent = true;
                clearTimeout(channelTimeout);
                sendResponse(response);
            }
        })
        .catch(error => {
            if (!responseSent) {
                responseSent = true;
                clearTimeout(channelTimeout);
                logger.error('Message handler error:', error);
                sendResponse({ error: error.message, status: 'error' });
            }
        });

    return true; // Keep message channel open for async response
});

/**
 * Handle incoming messages from content scripts, popup, sidepanel, and other extension contexts.
 * 
 * =========================================================================
 * BGW-C2 / BLOCK-M4 DOC: Message Handler Architecture
 * =========================================================================
 * 
 * This handler uses a switch statement for clarity and debugging ease.
 * Cases are grouped by functionality (30+ actions):
 * 
 * LIFECYCLE:           ping, heartbeat
 * BUSINESS DATA:       business_found, save_business_batch
 * EMAIL SCRAPING:      start/stop/resume_email_scraping, retry_failed_businesses
 * EXPORT:              export_data, export_emails_markdown, export_urls
 * STATS:               get_stats, get_live_stats, get_autoscaler_stats
 * SETTINGS:            update_config, update_settings
 * DATA MANAGEMENT:     clear_data, delete_business, delete_business_batch, factory_reset
 * AREA SEARCH:         start/pause/resume/stop_area_search, get_area_search_status
 * WEBSITE EXTRACTION:  extract/pause/resume/stop_website_extraction, get_businesses_without_website
 * MISC:                get_performance_stats, get_all_businesses, log_message
 * 
 * BGW-C2 REFACTOR NOTE:
 * A handler map pattern (ACTION_HANDLERS = { 'ping': handlePing, ... }) would improve
 * maintainability. Prerequisites: extract inline logic to named functions first.
 * Current inline handlers (update_settings, retry_failed_businesses, etc.) need extraction.
 * Deferred to future version to minimize risk during current release stabilization.
 * 
 * @param {Object} message - Message object with action and optional payload
 * @param {string} message.action - Action identifier
 * @param {*} [message.payload] - Action-specific payload
 * @param {chrome.runtime.MessageSender} sender - Message sender info
 * @returns {Promise<Object>} Response object with status and data
 */
async function handleMessage(message, sender) {
    const { action } = message;
    // D.1 audit (2026-05-09): null-coalesce payload to {} so case-level
    // accesses like `payload.businesses` / `payload.urls` (lines :502, :506)
    // don't throw TypeError when caller sends `{action}` with no payload.
    // The outer try/catch was already converting the TypeError to a generic
    // error response; this gives downstream handlers (handleBusinessBatch,
    // handleUrlImport, etc., which all already validate their input via
    // !arr || !Array.isArray() guards) a chance to emit clearer "Missing
    // X" responses. No regression: 0 occurrences of `if (payload)` /
    // `if (!payload)` in this file (verified via grep), so the truthiness
    // shift {undefined → {}} never flips a guard branch.
    const payload = message.payload || {};

    // M2-SEC1: Defense-in-depth sender origin validation
    const senderCheck = validateMessageSender(sender, action, chrome.runtime.id);
    if (!senderCheck.allowed) {
        logger.warn(`[MSG-SECURITY] ${senderCheck.reason} | action=${action}`);
        return { error: senderCheck.reason, status: 'rejected' };
    }

    // B1-2 P0 FIX: defense-in-depth init gate. Top-level await in module
    // load should already prevent uninitialized state, but if a message
    // slips in early (e.g. during the retry path or top-level await failure),
    // wait here. Lifecycle pings (ping/heartbeat) bypass the gate so health
    // checks always succeed even pre-init.
    if (!_initialized && action !== 'ping' && action !== 'heartbeat') {
        const ok = await _waitForInit(10000);
        if (!ok) {
            logger.warn(`[INIT-GATE] action=${action} rejected: init not complete after 10s`);
            return { error: 'Service worker not initialized', status: 'init_pending' };
        }
    }

    try {
        switch (action) {
            case 'ping':
                return { status: 'alive', timestamp: Date.now() };

            case 'heartbeat':
                // AUDIT FIX #4: Keepalive heartbeat
                return { status: 'alive', type: 'heartbeat', timestamp: Date.now() };

            case 'business_found':
                return await handleBusinessFound(payload);

            case 'business_enrichment':
                // R-DETAIL (2026-05-05): merge 6 CSV-only deep-fields into an
                // existing business record, keyed by normalized googleMapsUrl.
                // If the business doesn't exist yet (user opened detail panel
                // without scrolling list cards first), we no-op — the next
                // list-scrape will create it, and the user can re-open the
                // detail to enrich it. This keeps the data model "list first".
                return await handleBusinessEnrichment(payload);

            case 'selector_telemetry':
                // R10 (TIER A): aggregate per-strategy hit/miss snapshots from
                // content scripts into the SW-side Statistics singleton. The
                // payload is a snapshot of `selectorEngine.getTelemetry()`;
                // see lib/Statistics.js → recordSelectorTelemetry.
                try {
                    const snapshot = payload?.snapshot;
                    if (Array.isArray(snapshot) && snapshot.length > 0) {
                        const stats = getStatistics();
                        if (stats && typeof stats.recordSelectorTelemetry === 'function') {
                            // deltaMode=false: each content-script flush is the
                            // delta since last flush (sender resets on ack), so
                            // we want additive accumulation here.
                            stats.recordSelectorTelemetry(snapshot, { deltaMode: false });
                        }
                    }
                    return { ok: true };
                } catch (err) {
                    logger.debug(`[R10] telemetry ingest failed: ${err?.message}`);
                    return { ok: false, error: err?.message };
                }

            case 'save_business_batch':
                // AREA SEARCH FIX: Handle batch saves to prevent message flooding
                return await handleBusinessBatch(payload.businesses);

            case 'import_url_batch':
                // IO7: Bulk URL import - convert URLs to business objects
                return await handleUrlImport(payload.urls);

            // @deprecated 2026-05-07 (audit): no UI caller located in ui/*.js.
            // `update_settings` (case at :613) is the live UI path. This `update_config`
            // form is a legacy variant — candidate for removal in v9.13.
            case 'update_config':
                if (message.settings) {
                    const s = message.settings;
                    if (jobQueue) {
                        if (s.maxConcurrent) jobQueue.maxConcurrent = s.maxConcurrent;
                        if (s.rateLimit) {
                            jobQueue.meanDelayMs = 60000 / s.rateLimit;
                            jobQueue.jitterStdDev = jobQueue.meanDelayMs * 0.25;
                        }
                        logger.info(`Settings updated: ${JSON.stringify(s)}`);
                    }
                }
                if (message.config && message.config.selectors) {
                    // Step 03-03: Use safeMerge to prevent prototype pollution (M2-SEC2)
                    safeMerge(CONFIG.selectors, message.config.selectors);
                    logger.info(`Selectors updated: ${JSON.stringify(message.config.selectors)}`);
                }
                break;

            case 'start_email_scraping':
                return await startEmailScraping();

            case 'stop_email_scraping':
                return stopEmailScraping();

            case 'resume_email_scraping':
                // BUG FIX #3: Add resume handler for paused queue
                jobQueue.resume();
                const resumeStatus = jobQueue.getStatus();
                logger.info(`Queue resumed by user. Pending: ${resumeStatus.pending}, Active: ${resumeStatus.active}`);
                return {
                    status: 'resumed',
                    pending: resumeStatus.pending,
                    active: resumeStatus.active
                };

            // SAVE-DLQ (2026-05-28): drain the save dead-letter queue on demand.
            // Single-attempt (retry:false), budgeted inside drainDeadLetter so a
            // large queue can't stall. Mirrors retry_failed_businesses below.
            case 'drain_save_dead_letter': {
                const result = await drainDeadLetter((b) => saveBusiness(b, { retry: false }));
                const remaining = await getDeadLetterCount();
                logger.info(`[DLQ] Manual drain: recovered ${result.drained}, ${remaining} remaining`);
                return { ...result, remaining };
            }

            // P3-002 FIX: Retry failed businesses
            case 'retry_failed_businesses':
                try {
                    // Get failed businesses from database
                    const failedBusinesses = await getFailedBusinesses();

                    if (!failedBusinesses || failedBusinesses.length === 0) {
                        return { noFailed: true, message: 'No failed businesses to retry' };
                    }

                    logger.info(`[RETRY] Retrying ${failedBusinesses.length} failed businesses`);

                    // Reset their error state and queue for re-scraping
                    for (const business of failedBusinesses) {
                        // Reset error state - updateBusiness expects object with googleMapsUrl
                        await updateBusiness({
                            ...business,
                            emailScraped: false,
                            scrapeError: null
                        });

                        // Add to job queue if has website.
                        // 2026-05-15 FIX: same conversion as addEmailJob —
                        // typed-persistable instead of closure, so retry
                        // jobs also survive SW eviction.
                        if (business.website && jobQueue) {
                            let url = business.website;
                            if (url && !url.startsWith('http')) {
                                url = 'https://' + url;
                            }
                            const canonicalUrl = getCanonicalDbKey(business.googleMapsUrl);
                            jobQueue.addTypedJob('email_scrape', { canonicalUrl, url }, {
                                priority: business.priority || 0
                            });
                        }
                    }

                    // Start processing if not already running
                    if (!jobQueue.isProcessing) {
                        jobQueue.start();
                    }

                    // B12-3 fix: removed orphan `email_scraping_started`
                    // broadcast (zero UI listeners — verified again via grep
                    // 2026-05-10). Per the message-protocol audit policy,
                    // dead broadcasts are removed rather than retained as
                    // log-only side-effects: every broadcast walks through
                    // BROADCAST_LIMITER and IPC, which is wasted work when
                    // no consumer exists. If a UI toast is later wanted,
                    // re-add together with the listener wiring in the same
                    // PR so the protocol stays self-consistent.

                    return { success: true, count: failedBusinesses.length };
                } catch (retryError) {
                    logger.error('[RETRY] Failed to retry businesses:', retryError);
                    return { success: false, error: retryError.message };
                }

            case 'export_data':
                return await exportData();

            case 'export_emails_markdown':
                return await exportEmailsMarkdown();

            // @deprecated 2026-05-07 (audit): no UI caller located. Bulk URL export
            // is currently consumed via api_export_csv path. Candidate for removal v9.13.
            case 'export_urls':
                return await exportUrls();

            case 'get_stats':
                return await getStatsWithQueue();

            // NEW: Get live scraping statistics from Statistics module
            case 'get_live_stats':
                try {
                    const stats = getStatistics();
                    return stats.getStats();
                } catch (e) {
                    return { error: 'Statistics not available' };
                }

            // NEW: Get AutoScaler and SystemMonitor stats for UI
            case 'get_autoscaler_stats':
                try {
                    const asStats = getAutoScaler();
                    const smStats = getSystemMonitor();
                    return {
                        autoscaler: asStats.getStats(),
                        system: smStats.getStatus()
                    };
                } catch (e) {
                    return { error: 'AutoScaler stats not available' };
                }

            case 'update_settings':
                // P1-002 FIX: Define validation limits to prevent resource exhaustion
                const SETTINGS_LIMITS = {
                    maxConcurrent: { min: 1, max: 10 },    // 1-10 concurrent jobs max
                    rateLimit: { min: 2, max: 60 },        // 2-60 requests per minute
                    timeout: { min: 5, max: 120 }          // 5-120 seconds
                };

                // Apply settings immediately to jobQueue for seamless UX
                if (message.settings && jobQueue) {
                    const s = message.settings;

                    if (s.maxConcurrent !== undefined) {
                        // P1-002 FIX: Validate and clamp maxConcurrent
                        const mc = parseInt(s.maxConcurrent);
                        const validMC = Math.max(SETTINGS_LIMITS.maxConcurrent.min,
                            Math.min(SETTINGS_LIMITS.maxConcurrent.max, mc));
                        if (mc !== validMC) {
                            logger.warn(`[SETTINGS] maxConcurrent ${mc} clamped to ${validMC} (valid: ${SETTINGS_LIMITS.maxConcurrent.min}-${SETTINGS_LIMITS.maxConcurrent.max})`);
                        }
                        jobQueue.maxConcurrent = validMC;
                        logger.info(`[SETTINGS] maxConcurrent set to ${jobQueue.maxConcurrent}`);
                    }

                    if (s.rateLimit !== undefined && s.rateLimit > 0) {
                        // P1-002 FIX: Validate and clamp rateLimit
                        const rl = parseInt(s.rateLimit);
                        const validRL = Math.max(SETTINGS_LIMITS.rateLimit.min,
                            Math.min(SETTINGS_LIMITS.rateLimit.max, rl));
                        if (rl !== validRL) {
                            logger.warn(`[SETTINGS] rateLimit ${rl} clamped to ${validRL} (valid: ${SETTINGS_LIMITS.rateLimit.min}-${SETTINGS_LIMITS.rateLimit.max})`);
                        }
                        // rateLimit is requests per minute, convert to delay
                        jobQueue.meanDelayMs = Math.floor(60000 / validRL);
                        jobQueue.jitterStdDev = jobQueue.meanDelayMs * 0.25;
                        logger.info(`[SETTINGS] rateLimit set to ${validRL}/min (delay: ${jobQueue.meanDelayMs}ms)`);
                    }

                    if (s.timeout !== undefined) {
                        // P1-002 FIX: Validate and clamp timeout
                        const to = parseInt(s.timeout);
                        const validTO = Math.max(SETTINGS_LIMITS.timeout.min,
                            Math.min(SETTINGS_LIMITS.timeout.max, to));
                        if (to !== validTO) {
                            logger.warn(`[SETTINGS] timeout ${to}s clamped to ${validTO}s (valid: ${SETTINGS_LIMITS.timeout.min}-${SETTINGS_LIMITS.timeout.max})`);
                        }
                        // Store in CONFIG for future use
                        CONFIG.rateLimits.emailScraping.timeout = validTO * 1000;
                        logger.info(`[SETTINGS] timeout set to ${validTO}s`);
                    }
                }
                // Also persist to storage
                await loadSettings();
                return { status: 'updated', applied: true };

            case 'clear_data':
                return await clearAllData();

            case 'delete_business':
                // BROKEN CODE FIX: Handler for storage-modal delete functionality
                try {
                    if (!message.url) {
                        return { success: false, error: 'Missing URL parameter' };
                    }
                    await deleteBusiness(message.url);
                    return { success: true };
                } catch (error) {
                    logger.error('[DELETE_BUSINESS] Failed:', error);
                    return { success: false, error: error.message };
                }

            // UI-003 FIX: Batch delete for storage-modal performance
            // Reduces O(n) network calls to O(1) for bulk operations
            case 'delete_business_batch':
                try {
                    const urls = message.urls || [];
                    if (!Array.isArray(urls) || urls.length === 0) {
                        return { success: false, error: 'Missing or empty urls array', deleted: 0 };
                    }
                    let deleted = 0;
                    let errors = 0;
                    for (const url of urls) {
                        try {
                            await deleteBusiness(url);
                            deleted++;
                        } catch (e) {
                            errors++;
                            logger.warn('[DELETE_BATCH] Failed to delete:', url, e.message);
                        }
                    }
                    logger.info(`[DELETE_BATCH] Completed: ${deleted}/${urls.length} deleted, ${errors} errors`);
                    return { success: true, deleted, errors, total: urls.length };
                } catch (error) {
                    logger.error('[DELETE_BATCH] Failed:', error);
                    return { success: false, error: error.message, deleted: 0 };
                }

            case 'factory_reset':
                // Complete factory reset - wipes DB, storage, everything
                return await factoryReset();


            case 'get_queue_status':
                return jobQueue.getStatus();

            // @deprecated 2026-05-07 (audit): no UI caller for get_failed_jobs.
            // The "failed businesses" UI flow uses get_failed_businesses_count instead.
            case 'get_failed_jobs':
                // AUDIT FIX #10: Expose failed jobs to UI
                return {
                    failed: jobQueue.getFailedJobs(),
                    count: jobQueue.getFailedJobs().length
                };

            // @deprecated 2026-05-07 (audit): no UI caller. retry_failed_businesses
            // (case at :533) is the live UI retry path. This handler operates on
            // in-memory jobQueue failures; candidate for removal v9.13.
            case 'retry_failed_jobs':
                // OLD: In-memory job queue retry (only works for errors during execution)
                jobQueue.retryFailedJobs();
                return { status: 'retrying', count: jobQueue.getFailedJobs().length };

            // @deprecated 2026-05-07 (audit): no UI caller located via grep on ui/*.js.
            // ui/failed-modal.js may use it dynamically — verify before removing.
            case 'get_failed_businesses_count':
                // NEW: Get count of failed businesses from database
                return await getFailedBusinessesCount();

            // ========== AREA SEARCH (TURBO MODE) ==========

            // ========== AREA SEARCH (TURBO MODE) ==========

            case 'start_area_search':
                // P1 FIX: Start keep-alive to prevent SW termination during long sessions
                startKeepAlive();
                return await AreaSearch.start(payload);

            case 'pause_area_search':
                return AreaSearch.pause();

            case 'resume_area_search':
                return AreaSearch.resume();

            case 'stop_area_search':
                // P1 FIX: Stop keep-alive when area search ends
                stopKeepAlive();
                return await AreaSearch.stop();

            case 'get_area_search_status':
                return AreaSearch.status();

            // ========== WEBSITE EXTRACTION ==========

            case 'extract_missing_websites':
                return await extractMissingWebsites();

            case 'pause_website_extraction':
                // B5-1 fix: now async (state backed by chrome.storage.session).
                return await pauseWebsiteExtraction();

            case 'resume_website_extraction':
                return await resumeWebsiteExtraction();

            // @deprecated 2026-05-07 (audit): no UI caller located. UI uses
            // pause_website_extraction (live at sidepanel.js:595) but never stop.
            case 'stop_website_extraction':
                return await stopWebsiteExtraction();

            // @deprecated 2026-05-07 (audit): no UI caller located.
            case 'get_website_extraction_status':
                return await getWebsiteExtractionStatus();

            // @deprecated 2026-05-07 (audit): no UI caller via grep — failed-modal
            // may use it dynamically. Verify before removing in v9.13.
            case 'get_businesses_without_website':
                const businessesWithoutWebsite = await getBusinessesWithoutWebsite();
                return {
                    status: 'success',
                    count: businessesWithoutWebsite.length,
                    businesses: businessesWithoutWebsite
                };


            // @deprecated 2026-05-07 (audit): no UI caller — likely DevTools-only.
            case 'get_performance_stats':
                return {
                    status: 'success',
                    stats: performanceMonitor.getStats(),
                    queue: jobQueue.getStatus()
                };

            case 'get_all_businesses':
                // AUDIT FIX: Added error handling and consistent response format
                try {
                    const allBusinesses = await getBusinesses();
                    return {
                        status: 'success',
                        businesses: allBusinesses || [],
                        count: allBusinesses?.length || 0
                    };
                } catch (error) {
                    logger.error('[Background] Failed to get businesses:', error);
                    return {
                        status: 'error',
                        error: error.message,
                        businesses: [] // Fallback to empty array
                    };
                }

            // B10-3 FIX (2026-05-10): server-side filter for "old businesses
            // with email" cleanup. Pre-fix storage-modal fetched ALL
            // businesses (potentially 8MB+ IPC payload, risk of silent
            // truncation at ~10MB Chrome internal limit) then filtered
            // client-side. Now SW does cursor-based filter and returns
            // only URL identifiers. UI dispatches delete_business_batch.
            case 'get_old_emailed_business_ids': {
                const daysAgo = (typeof payload?.daysAgo === 'number' && payload.daysAgo > 0)
                    ? payload.daysAgo
                    : 7;
                const cutoffMs = Date.now() - (daysAgo * 24 * 60 * 60 * 1000);
                try {
                    const ids = await getOldEmailedBusinessIds(cutoffMs);
                    return { status: 'success', urls: ids, count: ids.length };
                } catch (error) {
                    logger.error('[Background] get_old_emailed_business_ids failed:', error);
                    return { status: 'error', error: error.message, urls: [] };
                }
            }

            case 'get_old_business_ids': {
                const daysAgo = (typeof payload?.daysAgo === 'number' && payload.daysAgo > 0)
                    ? payload.daysAgo
                    : 30;
                const cutoffMs = Date.now() - (daysAgo * 24 * 60 * 60 * 1000);
                try {
                    const ids = await getOldBusinessIds(cutoffMs);
                    return { status: 'success', urls: ids, count: ids.length };
                } catch (error) {
                    logger.error('[Background] get_old_business_ids failed:', error);
                    return { status: 'error', error: error.message, urls: [] };
                }
            }

            case 'log_message':
                // Ignore logs broadcasted by utils.js (they are for the UI)
                return null;

            // =====================================================
            // IO6: EXPORT API ENDPOINTS
            // =====================================================
            case API_MESSAGE_TYPES.API_GET_BUSINESSES:
            case API_MESSAGE_TYPES.API_GET_BUSINESS:
            case API_MESSAGE_TYPES.API_GET_STATS:
            case API_MESSAGE_TYPES.API_EXPORT_JSON:
            case API_MESSAGE_TYPES.API_EXPORT_CSV:
            case API_MESSAGE_TYPES.API_EXPORT_MARKDOWN:
            case API_MESSAGE_TYPES.API_REGISTER_WEBHOOK:
            case API_MESSAGE_TYPES.API_UNREGISTER_WEBHOOK:
            case API_MESSAGE_TYPES.API_LIST_WEBHOOKS:
            case API_MESSAGE_TYPES.API_GET_VERSION:
            case API_MESSAGE_TYPES.API_HEALTH_CHECK:
                return ExportAPI.handleApiMessage(message, sender);

            case 'api_get_key':
                // Get or create API key for external integrations
                const apiKey = await ExportAPI.getOrCreateApiKey();
                return { success: true, apiKey };

            case 'api_regenerate_key':
                // Regenerate API key (invalidates old key)
                const newApiKey = await ExportAPI.regenerateApiKey();
                return { success: true, apiKey: newApiKey };

            case 'sync_to_opportuni': {
                // Opportuni cloud sync (opt-in, additive). De-identifies email/phone/social.
                let businesses = Array.isArray(payload?.businesses) ? payload.businesses : [];
                // If the caller didn't supply a batch, pull the latest from local IndexedDB.
                if (businesses.length === 0) {
                    try {
                        const all = await getBusinesses();
                        // Most recent first, cap at 1000 per batch
                        businesses = (Array.isArray(all) ? all : [])
                            .slice()
                            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                            .slice(0, 1000);
                    } catch (e) {
                        logger.warn('[opportuni] getBusinesses fallback failed:', e?.message);
                        businesses = [];
                    }
                }
                logger.info(`[opportuni] sync_to_opportuni: batch_size=${businesses.length}`);
                const result = await syncToOpportuni({
                    snapshotId: payload?.snapshotId || `gmp-${Date.now()}`,
                    coverageComplete: !!payload?.coverageComplete,
                    businesses
                });
                return { success: true, batch_size: businesses.length, ...result };
            }

            // B2-4 FIX (2026-05-10): detail-fetcher kill-switch state forwarded
            // from observer.js (which received it from MAIN-world detail-fetcher
            // via postMessage). The runtime message auto-broadcasts to all
            // listeners — sidepanel + area-search-modal pick it up for UI.
            // SW-side: log + return ok (avoids "Unknown action" warn).
            // Future: persist kill-switch state in chrome.storage.session for
            // SW-eviction-safe diagnostics.
            case 'detail_fetcher_kill_switch': {
                const tripped = !!payload?.tripped;
                const fails = typeof payload?.consecutiveFails === 'number' ? payload.consecutiveFails : 0;
                if (tripped) {
                    logger.warn(`[DETAIL-FETCHER] Kill switch TRIPPED after ${fails} consecutive failures (origin: content-script).`);
                } else {
                    logger.info('[DETAIL-FETCHER] Kill switch RESET (origin: content-script).');
                }
                return { ok: true, status: 'forwarded' };
            }

            default:
                logger.warn('Unknown action:', action);
                return { error: 'Unknown action', status: 'error' };
        }
    } catch (error) {
        logger.error('Error handling action:', action, error);
        // Serialize error properly (DOMException doesn't stringify well)
        return {
            error: error.message || String(error),
            status: 'error',
            action
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// IO7: URL IMPORT HANDLER
// ─────────────────────────────────────────────────────────────────────────────
// Converts URL list to synthetic business objects and reuses handleBusinessBatch
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Import URLs as synthetic business entries
 * Reuses handleBusinessBatch() for actual saving - zero new DB code
 * 
 * @param {string[]} urls - Array of website URLs
 * @returns {Object} { success, saved, duplicates, errors }
 */
async function handleUrlImport(urls) {
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        logger.warn('[IO7] Import called with no URLs');
        return { success: false, error: 'No URLs provided', saved: 0, duplicates: 0 };
    }

    logger.info(`[IO7] Importing ${urls.length} URLs...`);

    // BG-15 FIX (2026-05-10): pre-fix the synthetic googleMapsUrl was built
    // from `Date.now() + Math.random().toString(36).substr(2, 6) + index`,
    // which had three problems:
    //   1) NON-DETERMINISTIC: re-importing the same URL list produced
    //      different keys each time, defeating the dedup logic in
    //      handleBatch() and creating duplicate DB rows on every retry.
    //   2) deprecated `substr()` API.
    //   3) variable random length (e.g. trailing zeros stripped) — keys not
    //      uniformly sized.
    // Now: synchronously hash the source URL (FNV-1a 32-bit) and use the
    // hex digest as a stable key. Same URL → same key always; the dedup
    // path in handleBatch() correctly drops repeats.
    const businesses = urls.map((url) => {
        let hostname;
        try {
            hostname = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            hostname = url;
        }

        // FNV-1a 32-bit (deterministic, no deps, ~6 chars hex)
        let hash = 0x811c9dc5;
        for (let i = 0; i < url.length; i++) {
            hash ^= url.charCodeAt(i);
            // Mul by FNV prime modulo 2^32
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        const key = hash.toString(16).padStart(8, '0');

        return {
            // Synthetic Google Maps URL — deterministic per (url) so re-imports
            // dedup correctly. Format: import://<hostname>/<hash>
            googleMapsUrl: `import://${hostname}/${key}`,
            title: hostname,
            category: 'Imported',
            website: url,
            phone: '',
            address: '',
            rating: null,
            reviews: null,
            timestamp: Date.now(),
            emailScraped: false,
            source: 'url_import'
        };
    });

    // Reuse existing batch handler - it handles deduplication, validation, and saving
    const result = await handleBusinessBatch(businesses);

    logger.info(`[IO7] Import complete: ${result.saved} saved, ${result.duplicates} duplicates, ${result.errors} errors`);

    return {
        success: true,
        saved: result.saved,
        duplicates: result.duplicates,
        errors: result.errors
    };
}

/**
 * Handle new business found
 * AUDIT FIX #6: Normalize URLs to prevent duplicates
 */
async function handleBusinessFound(business) {
    try {
        // v9.10: lookup MUST use canonical DB key form (`%3A` encoded), not
        // the raw `:` form from `normalizeGoogleMapsUrl` alone — `saveBusiness`
        // stores under the canonical key, so a non-canonical lookup would
        // miss every existing record. Discovered during URL refactor audit:
        // same bug class as enrichment Bug #4 (HANDOFF_v9.9.0_DETAIL_FETCH).
        // Pre-v9.10 this path silently degraded to "always saved" (store.put
        // is upsert so no DB corruption, but `result.duplicates` was always
        // 0 — duplicate detection was effectively dead code).
        const dbKey = getCanonicalDbKey(business.googleMapsUrl);
        logger.debug(`[BUSINESS] Original URL: ${business.googleMapsUrl}`);
        logger.debug(`[BUSINESS] Canonical DB key: ${dbKey}`);

        business.googleMapsUrl = dbKey;
        const normalizedUrl = dbKey;

        const existing = await getBusiness(dbKey);
        if (existing) {
            // Fill-holes merge-on-duplicate. First-save-wins previously dropped
            // EVERY field that arrived after the initial save — proven via the
            // DUALPATH instrumented run (2026-05-28): the content-script observer
            // saves each card during scroll, so area-search's later save (carrying
            // the radius stamp searchCenterLat/Lon/RadiusKm) hit this branch and
            // was discarded 79/79. Now a later save back-fills only the holes;
            // populated fields are never overwritten. Guarded by `changed` so the
            // hot path (same card re-fires business_found many times per scroll)
            // does NOT write when there is nothing new.
            const { merged, changed } = fillHolesMerge(existing, business, ['googleMapsUrl']);
            if (changed) {
                await saveBusiness(merged);
                logger.debug('[BUSINESS] Duplicate back-filled (fill-holes):', business.title);
                return { status: 'duplicate', merged: true, id: normalizedUrl };
            }
            logger.debug('[BUSINESS] Already exists, nothing to merge:', business.title);
            return { status: 'duplicate', id: normalizedUrl };
        }

        // Save to database
        await saveBusiness(business);
        logger.info('[BUSINESS] Saved:', business.title);
        logger.info('[STEP 3] Email saved. Moving to next job...');

        // v9.10: post-save retry-queue drain. If a business_enrichment for
        // this dbKey arrived BEFORE this save completed (~2-3% on v9.9.0),
        // it's queued waiting for the row to exist. Drain it now — faster
        // than the 500ms timer in the queue.
        const queuedPayload = enrichmentRetryQueue.takeIfReady(dbKey);
        if (queuedPayload) {
            try {
                await _doEnrichmentMerge(business, queuedPayload.fields, dbKey);
            } catch (mergeErr) {
                logger.warn(`[ENRICH] post-save drain failed for ${dbKey}: ${mergeErr?.message}`);
            }
        }

        // Check auto-scrape setting
        // PHASE 4 FIX: Disable auto-scrape on discovery to separate processes
        // User wants "JUST THE NEW SCRIPT" (Batch Mode)
        /*
        const settings = await chrome.storage.local.get(['autoScrape']);
        if (settings.autoScrape && business.website && !business.emailScraped) {
            addEmailJob(business);
        }
        */

        return { status: 'saved', id: normalizedUrl };

    } catch (error) {
        logger.error('[BUSINESS] Failed to save:', error);
        throw error;
    }
}

/**
 * R-DETAIL (2026-05-05): Merge CSV-only deep-fields into an existing business.
 *
 * Source: content/gmb/observer.js → `_tryEnrichDetail` → `business_enrichment`
 * Sink:   IndexedDB business record (keyed by normalized googleMapsUrl)
 * UI:     none — these fields are render-suppressed in the sidepanel and
 *         only surface in the CSV export (see background/data-exporter.js).
 *
 * Behavior:
 *   - If the business exists: merge the 6 fields, preserving non-null existing
 *     values (we never overwrite a populated field with null/empty).
 *   - If the business does NOT exist: no-op. Returning `not_found` lets the
 *     content script log it and (optionally) retry after the list scrape
 *     populates the row. This keeps the data model "list first" and avoids
 *     creating phantom rows from drive-by detail panels.
 *
 * Idempotent: re-sending the same payload does not corrupt state — the merge
 * is a strict "fill the holes" operation.
 *
 * @param {{googleMapsUrl: string, fields: object}} payload
 * @returns {Promise<{status: string, id?: string}>}
 */
async function handleBusinessEnrichment(payload) {
    try {
        if (!payload || !payload.googleMapsUrl || !payload.fields) {
            return { status: 'rejected', error: 'invalid_payload' };
        }
        // v9.10: single canonical helper. Previously this block manually
        // replicated db._normalizeGoogleMapsUrl's searchParams.delete trick
        // (commit eb60ab4) — error-prone. getCanonicalDbKey owns the full
        // pipeline (urlNormalizer step + searchParams.delete encoding).
        const dbKey = getCanonicalDbKey(payload.googleMapsUrl);
        let existing = await getBusiness(dbKey);
        if (!existing) {
            // TODO-2026-05-21: Remove legacy-shape fallback after 2 weeks
            // of clean SW logs (no `[ENRICH] legacy-shape match` lines).
            // Was the safety net during the 2-fn → 1-fn migration; if
            // canonical helper is truly canonical, this is dead code.
            const legacyShape = normalizeGoogleMapsUrl(payload.googleMapsUrl);
            if (legacyShape && legacyShape !== dbKey) {
                existing = await getBusiness(legacyShape);
                if (existing) logger.info(`[ENRICH] legacy-shape match for ${legacyShape}`);
            }
        }
        if (!existing) {
            // v9.10: race-window retry queue. If business_enrichment beat
            // business_found to the SW (~2-3% on v9.9.0), enqueue and let
            // either (a) the post-save hook in handleBusinessFound or (b) a
            // 500ms/1s/2s timer drain it. Hard expiry at 30s.
            enrichmentRetryQueue.enqueue(dbKey, payload, async (key, p) => {
                const e = await getBusiness(key);
                if (!e) return false;
                await _doEnrichmentMerge(e, p.fields, key);
                return true;
            });
            logger.info(`[ENRICH] No existing business for ${dbKey} — queued for retry`);
            return { status: 'queued', id: dbKey };
        }
        await _doEnrichmentMerge(existing, payload.fields, dbKey);
        return { status: 'enriched', id: dbKey };
    } catch (error) {
        logger.error('[ENRICH] failed:', error);
        return { status: 'error', error: error.message };
    }
}

/**
 * Strict "fill the holes" merge of detail-fetch fields into an existing
 * business record, then persist via saveBusiness. Extracted v9.10 so the
 * retry queue can call the merge directly without recursing through
 * handleBusinessEnrichment.
 *
 * Idempotent: re-running with same inputs is a no-op (saveBusiness
 * upserts, merge never overwrites a populated field).
 *
 * @param {object} existing - Current DB record (must be non-null)
 * @param {object} fields - Detail-fetch payload.fields
 * @param {string} dbKey - Canonical DB key (for logging only)
 */
async function _doEnrichmentMerge(existing, fields, dbKey) {
    const f = fields || {};
    const merged = { ...existing };
    if (!merged.placeId && f.placeId) merged.placeId = f.placeId;
    if (!merged.description && f.description) merged.description = f.description;
    if ((!merged.claimStatus || merged.claimStatus === 'unknown') && f.claimStatus && f.claimStatus !== 'unknown') {
        merged.claimStatus = f.claimStatus;
    }
    if (!merged.lastUpdatedByOwner && f.lastUpdatedByOwner) {
        merged.lastUpdatedByOwner = f.lastUpdatedByOwner;
    }
    if (Array.isArray(f.reviewThemes) && f.reviewThemes.length > 0) {
        const existingCount = Array.isArray(merged.reviewThemes) ? merged.reviewThemes.length : 0;
        if (f.reviewThemes.length >= existingCount) {
            merged.reviewThemes = f.reviewThemes;
        }
    }
    if (f.reviewDistribution && typeof f.reviewDistribution === 'object') {
        const sum = (d) => Object.values(d || {}).reduce((a, b) => a + (Number(b) || 0), 0);
        if (sum(f.reviewDistribution) >= sum(merged.reviewDistribution)) {
            merged.reviewDistribution = f.reviewDistribution;
        }
    }
    if (!merged.phone && f.phone) merged.phone = f.phone;
    if (!merged.address && f.address) merged.address = f.address;
    if (!merged.website && f.website) merged.website = f.website;
    // EXP-01 FIX (2026-06-10): fill latitude/longitude holes from the
    // enrichment (observer propagates the card-URL coords). Pre-fix these
    // never merged, so only ~21% of rows (JSPB state catalog) had coords and
    // the export radius filter ran fail-open on the rest. Type+range
    // validated here too — different trust boundary than the content script.
    if (merged.latitude == null && typeof f.latitude === 'number'
        && Number.isFinite(f.latitude) && Math.abs(f.latitude) <= 90) {
        merged.latitude = f.latitude;
    }
    if (merged.longitude == null && typeof f.longitude === 'number'
        && Number.isFinite(f.longitude) && Math.abs(f.longitude) <= 180) {
        merged.longitude = f.longitude;
    }
    if ((merged.rating == null || merged.rating === '') && f.rating != null) {
        merged.rating = f.rating;
    }
    // v9.12 Wave 1.1 (2026-05-08): reviewCount captured by anchor-based rating
    // regex, paired with rating in pb (rating,reviewCount tuple).
    if ((merged.reviewCount == null || merged.reviewCount === '') && f.reviewCount != null) {
        merged.reviewCount = f.reviewCount;
    }
    // v9.12 Wave 1: hours raw from /maps/preview/place pb response. Telemetry
    // tracks parse hit rate so smoke run reveals if the regex pattern matches
    // real Maps responses (PROVISIONAL — see content/gmb/detail-fetcher.js).
    if (!merged.hoursRaw && f.hoursRaw) merged.hoursRaw = f.hoursRaw;
    if (merged.hoursDaysFound == null && f.hoursDaysFound != null) {
        merged.hoursDaysFound = f.hoursDaysFound;
    }
    if (f.hoursRaw) {
        enrichmentTelemetry.hoursFound++;
        enrichmentTelemetry.hoursDaysFoundSum += (f.hoursDaysFound || 0);
    } else {
        enrichmentTelemetry.hoursMissing++;
    }
    await saveBusiness(merged);
    logger.info(`[ENRICH] Merged deep-fields for ${merged.title || dbKey}`);
}

/**
 * Handle batch of businesses from Area Search
 * Prevents message queue overflow by processing multiple businesses in one message
 * @param {Array} businesses - Array of business objects to save
 * @returns {Object} Results with saved/duplicate/error counts
 */
async function handleBusinessBatch(businesses) {
    const results = { saved: 0, duplicates: 0, errors: 0, quotaFailures: 0, dlqDropped: 0 };

    if (!businesses || !Array.isArray(businesses)) {
        logger.error('[BATCH] Invalid businesses array');
        return results;
    }

    logger.info(`[BATCH] Processing ${businesses.length} businesses...`);

    for (const business of businesses) {
        try {
            const result = await handleBusinessFound(business);

            if (result.status === 'saved') {
                results.saved++;
            } else if (result.status === 'duplicate') {
                results.duplicates++;
            }
        } catch (error) {
            // SAVE-DLQ (2026-05-28): a save that survived db.saveBusiness's retry
            // is a real loss unless we recover it. Two distinct paths:
            //   • Quota — storage is FULL. Dead-lettering it would write MORE to a
            //     full store (self-defeating), so we DON'T enqueue; we count it for
            //     a distinct "storage full" UI signal instead.
            //   • Transient/other — persist to the DLQ for next-run recovery. The
            //     enqueue is wrapped: if IT fails (e.g. storage also full), we
            //     degrade to dlqDropped and NEVER let the exception escape — an
            //     un-guarded throw here would trip saveBatch's outer catch
            //     (area-search.js) and drop the WHOLE batch count.
            results.errors++;
            const isQuota = error?.name === 'QuotaExceededError' || /quota/i.test(error?.message || '');
            if (isQuota) {
                results.quotaFailures++;
                logger.error('[BATCH] Save failed (QUOTA — not dead-lettered):', business.title);
            } else {
                try {
                    await enqueueDeadLetter(business, error?.name || error?.message || 'unknown');
                    logger.error('[BATCH] Save failed (dead-lettered for retry):', business.title, error.message);
                } catch (dlqErr) {
                    results.dlqDropped++;
                    logger.error('[BATCH] Dead-letter enqueue failed; record lost:', business.title, dlqErr?.name);
                }
            }
        }
    }

    logger.info(`[BATCH] Complete: ${results.saved} saved, ${results.duplicates} duplicates, ${results.errors} errors (${results.quotaFailures} quota, ${results.dlqDropped} dlq-dropped)`);
    return results;
}

/**
 * Start email scraping batch - NON-BLOCKING VERSION
 */
async function startEmailScraping() {
    try {
        // Check if scraping is already in progress
        const queueStatus = jobQueue.getStatus();
        if (queueStatus.active > 0 || queueStatus.pending > 0) {
            logger.warn(`Email scraping already in progress. ${queueStatus.pending} pending, ${queueStatus.active} active jobs.`);
            return { status: 'already_running', pending: queueStatus.pending, active: queueStatus.active };
        }

        logger.info('Starting email scraping...');
        logger.info('>>> STARTING BATCH EMAIL EXTRACTION (New Script Logic) <<<');

        // Get businesses - this is async so it's fine
        const targets = await getBusinessesForEmailScraping();
        logger.info(`Found ${targets.length} businesses to scrape`);

        if (targets.length === 0) {
            broadcastMessage({
                action: 'email_scraping_finished',
                payload: { count: 0, message: 'No websites found to scrape.' }
            });
            // FIX: Enhanced response with reason and hint
            return {
                status: 'no_targets',
                count: 0,
                reason: 'no_websites_in_database',
                hint: 'Use "Extract Websites" to find websites for scraped businesses'
            };
        }

        // Filter valid targets FIRST (quick operation)
        const validTargets = targets.filter(b => isValidScrapableUrl(b.website));
        const invalidTargets = targets.filter(b => !isValidScrapableUrl(b.website));

        // Initialize progress tracking
        totalEmailJobs = validTargets.length;
        completedEmailJobs = 0;
        currentBusinessName = '';
        _schedulePersistEmailProgress();  // BG-4: persist start-of-batch state

        // Broadcast initial progress
        broadcastMessage({
            action: 'scraping_progress',
            payload: {
                current: 0,
                total: totalEmailJobs,
                currentItem: `Queuing ${totalEmailJobs} jobs...`
            }
        });

        // Start keepalive
        startKeepAlive();

        // BUG-FIX: Setup offscreen document BEFORE adding jobs
        // Previously this was fire-and-forget with .catch(), causing race condition
        // where jobs would start before offscreen was ready → "not responsive" errors
        try {
            await setupOffscreenDocument();
            logger.info('[OFFSCREEN] ✓ Document ready before job queue starts');
        } catch (setupErr) {
            logger.warn('[OFFSCREEN] Setup failed, will use direct parsing fallback:', setupErr instanceof Error ? setupErr.message : String(setupErr));
        }

        // ⚡ KEY FIX: Add jobs in batches to prevent UI freeze
        // Return immediately, queue jobs in background
        addJobsInBatches(validTargets, invalidTargets);

        // UX-1: start phase-2 heartbeat so UI gets progress signal every 2s
        // even when no email_found / job_complete events fire (slow CMSs,
        // circuit-breaker pause, tab-fallback cascade).
        _startPhase2Heartbeat();

        // Return immediately - don't wait for all jobs to be added
        return {
            status: 'started',
            count: validTargets.length,
            message: `Queuing ${validTargets.length} jobs...`
        };

    } catch (error) {
        logger.error('Failed to start email scraping:', {
            name: error.name,
            message: error.message,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Add jobs in batches with yielding to prevent UI freeze
 * This runs AFTER we've returned to the UI
 */
async function addJobsInBatches(validTargets, invalidTargets) {
    const BATCH_SIZE = 10;  // Process 10 at a time

    // M2-RACE1 FIX: Reset cancellation token before starting batch additions
    jobQueue.resetCancellation();

    let addedCount = 0;

    // Process valid targets in batches
    for (let i = 0; i < validTargets.length; i += BATCH_SIZE) {
        // M2-RACE1 FIX: Check cancellation token between batches
        if (jobQueue.isCancellationRequested()) {
            logger.info(`[BATCH] Cancellation requested after ${addedCount} jobs, stopping batch additions`);
            break;
        }

        const batch = validTargets.slice(i, i + BATCH_SIZE);

        // Add this batch
        batch.forEach(business => {
            addEmailJob(business);
            addedCount++;
        });

        // Update progress
        broadcastMessage({
            action: 'queue_progress',
            payload: {
                queued: addedCount,
                total: validTargets.length,
                message: `Queued ${addedCount}/${validTargets.length} jobs...`
            }
        });

        // YIELD to main thread - prevents freeze
        if (i + BATCH_SIZE < validTargets.length) {
            await yieldToMainThread();
        }
    }

    // Mark invalid URLs as processed (also in batches)
    for (let i = 0; i < invalidTargets.length; i += BATCH_SIZE) {
        // M2-RACE1 FIX: Also respect cancellation for invalid target processing
        if (jobQueue.isCancellationRequested()) {
            logger.info(`[BATCH] Cancellation requested, stopping invalid target processing`);
            break;
        }

        const batch = invalidTargets.slice(i, i + BATCH_SIZE);

        for (const business of batch) {
            logger.info(`Skipping invalid/social URL for ${business.title}: ${business.website}`);
            await updateBusiness({
                ...business,
                emailScraped: true,
                scrapedFrom: 'skipped_invalid_url'
            });
        }

        // Yield between batches
        if (i + BATCH_SIZE < invalidTargets.length) {
            await yieldToMainThread();
        }
    }

    logger.info(`All ${addedCount} jobs queued successfully`);

    // Broadcast completion of queuing
    broadcastMessage({
        action: 'queue_ready',
        payload: {
            count: addedCount,
            message: `All ${addedCount} jobs queued. Scraping started.`
        }
    });
}

/**
 * Yield to main thread to prevent blocking
 * Uses setTimeout(0) which allows other tasks to run
 */
function yieldToMainThread() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Stop email scraping
 */
function stopEmailScraping() {
    // M2-RACE1 FIX: Request cancellation so addJobsInBatches stops between batches
    jobQueue.requestCancellation();
    jobQueue.pause();
    stopKeepAlive();
    _stopPhase2Heartbeat();  // UX-1: stop heartbeat on user-requested pause
    logger.info('Email scraping paused');
    return { status: 'paused' };
}

/**
 * Add email scraping job to queue
 * PHASE 3 FIX #24: Added business name to metadata for progress tracking
 */
function addEmailJob(business) {
    // Ensure URL has protocol for consistency
    let url = business.website;
    if (url && !url.startsWith('http')) {
        url = 'https://' + url;
    }

    // 2026-05-15 FIX: typed-persistable instead of closure. The closure
    // form `jobQueue.add(async () => ...)` was `persistable=false`,
    // making saveQueue() always write 0 jobs and breaking auto-resume
    // after SW eviction. See comment near jobQueue.registerJobType()
    // call site for full background.
    const canonicalUrl = getCanonicalDbKey(business.googleMapsUrl);
    // url in params (read by addTypedJob to set job.domain for rate
    // limiter). canonicalUrl is the IndexedDB key used by the
    // 'email_scrape' factory to refetch fresh business state on restore.
    jobQueue.addTypedJob('email_scrape', { canonicalUrl, url }, {
        priority: business.priority || 0
    });
}

/**
 * Wrapper: Scrape email for business using email-scraper module
 * Adapts the module function to work with local context
 */
async function scrapeEmailForBusiness(business) {
    // BG-5: register THIS worker's target so the concurrent broadcast
    // can show all active items rather than overwriting a shared global.
    // The url is unique per business → safe map key under concurrency.
    const url = business.googleMapsUrl;
    const name = business.title || 'Unknown';
    _setCurrentBusinessName(url, name);
    // Legacy alias kept for downstream readers that depend on the string.
    currentBusinessName = name;

    // Wrapper for parseHTMLInOffscreen that uses local context
    const parseWrapper = async (html, url) => {
        return await parseHTMLInOffscreen(html, url);
    };

    // Call module function with wrapper
    logger.info('[DEBUG_UI] Calling scrapeEmailForBusinessModule from index.js');
    try {
        const result = await scrapeEmailForBusinessModule(business, name, parseWrapper);
        return await _scrapeEmailForBusinessHandleResult(result, business, url);
    } finally {
        // BG-5: always clear this worker's slot on completion / error.
        _clearCurrentBusinessName(url);
    }
}

// Helper to keep the original function body identical post-fix while still
// running inside the try/finally. The original return path is unchanged.
async function _scrapeEmailForBusinessHandleResult(result, business, url) {

    // Broadcast email found message
    if (result.emails && result.emails.length > 0) {
        broadcastMessage({
            action: 'email_found',
            payload: {
                id: business.googleMapsUrl,
                email: result.emails.join(', '),
                source: result.successfulPage
            }
        });
    }

    return result;
}

/**
 * Parse HTML in offscreen document (with fallback)
 * AUDIT FIX #2: Target-based routing eliminates race condition
 * PATCH #7: Added 15s timeout to prevent hangs
 * FIX-002: Now ensures offscreen document exists before sending messages
 */
async function parseHTMLInOffscreen(html, url) {
    // FIX-002: Ensure offscreen document exists before sending message
    // This was the root cause of "Failed, using direct parsing fallback"
    try {
        await setupOffscreenDocument();
    } catch (setupError) {
        logger.warn('[OFFSCREEN] Setup failed, using direct parsing:', setupError.message);
        return parseHTMLDirect(html, url);
    }

    const OFFSCREEN_TIMEOUT = 15000; // 15 seconds

    // P1-001 FIX: Generate unique requestId for message correlation
    // Prevents data misattribution when multiple concurrent requests occur
    const requestId = `parse_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    // BG-3 FIX (2026-05-10): track the timeout handle so we can clear it
    // when the response wins the Promise.race. Pre-fix the setTimeout was
    // never cleared on the success path: 100 sequential parses leaked 100
    // pending 15-second timers, each holding a Promise reject closure
    // (~few KB) AND resetting the SW's idle clock — preventing eviction
    // and accumulating memory across heavy email-scraping batches.
    let timeoutId;
    try {
        const responsePromise = chrome.runtime.sendMessage({
            action: 'parse_html',
            target: 'offscreen',
            requestId: requestId,  // P1-001 FIX: Add correlation ID
            payload: { html, url }
        });

        // PATCH #7: Race against timeout
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error('OFFSCREEN_PARSE_TIMEOUT')),
                OFFSCREEN_TIMEOUT,
            );
        });

        const response = await Promise.race([responsePromise, timeoutPromise]);

        // P1-001 FIX: Verify requestId matches to prevent misattribution
        if (response && response.success && response.source === 'offscreen') {
            if (response.requestId && response.requestId !== requestId) {
                logger.warn(`[OFFSCREEN] RequestId mismatch: expected ${requestId}, got ${response.requestId}`);
                return parseHTMLDirect(html, url);
            }
            return response.data;
        } else {
            logger.warn('[OFFSCREEN] Failed, using direct parsing fallback');
            return parseHTMLDirect(html, url);
        }
    } catch (error) {
        if (error.message === 'OFFSCREEN_PARSE_TIMEOUT') {
            logger.warn('[OFFSCREEN] Parsing timed out after 15s, using fallback');
        } else {
            logger.warn('[OFFSCREEN] Error, using direct parsing fallback:', error.message);
        }
        return parseHTMLDirect(html, url);
    } finally {
        // BG-3 FIX: clear the racing timer regardless of which branch wins.
        // clearTimeout(undefined) is a no-op so the sync-reject case (timer
        // never assigned) is safe. clearTimeout on an already-fired timer
        // is also a no-op.
        clearTimeout(timeoutId);
    }
}

/**
 * Fallback: Parse HTML directly in background (when offscreen unavailable)
 * Uses simplified user-provided regex
 */

/**
 * LAST-SYNCED: 2026-05-26 with lib/EmailExtractor.js:_stripIdentifierPrefix
 * (commit 3ce8b1d, 2026-05-17 — OBS-3 fix).
 *
 * Tactical duplication (Option B of BUG-4 RCA). The strategic fix (import
 * lib/EmailExtractor here) is tracked as DEBT-1 — requires making
 * EmailExtractor portable to offscreen context (currently has logger,
 * obfuscation-decoder, cloudflare-decoder deps assuming SW environment).
 *
 * Until DEBT-1 is resolved, any change to lib/EmailExtractor.js
 * :_stripIdentifierPrefix MUST be mirrored here AND in
 * offscreen/parser.js:_stripIdentifierPrefix.
 */
function _stripIdentifierPrefix(email) {
    if (typeof email !== 'string') return email;
    const atIdx = email.indexOf('@');
    if (atIdx <= 0) return email;
    const local = email.slice(0, atIdx);
    const rest = email.slice(atIdx); // includes the @

    // 1. Italian Codice Fiscale: 6 letters, 2 digits, 1 letter, 2 digits,
    //    1 letter, 3 digits, 1 letter — 16 chars total.
    const cf = /^[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]/;
    if (cf.test(local) && local.length > 16) {
        return local.slice(16) + rest;
    }

    // 2. Italian P.IVA: 11 consecutive digits at start.
    if (/^\d{11}/.test(local) && local.length > 11) {
        return local.slice(11) + rest;
    }

    return email;
}

/**
 * Fallback: Parse HTML directly in background (when offscreen unavailable)
 * Uses simplified user-provided regex with deobfuscation
 * CRITICAL FIX: Now includes Italian tax code extraction (P.IVA, C.F.)
 * FIX-003: Added third-party email domain blacklist
 * FIX-004: Added TLD cleaning and unicode prefix removal
 */
function parseHTMLDirect(html, url) {
    const emails = new Set();

    // BLOCK-5 FIX (MED-001): Use centralized CONFIG blacklist instead of inline duplicate
    // This ensures all email filtering uses the same list (maintainability)
    const emailBlacklist = CONFIG.extraction.email.blacklist;

    // Valid TLDs for cleaning garbage suffixes
    // CRITICAL FIX-006: Ordered by LENGTH DESC to prevent .com → .co truncation!
    // (Previously 'co' was matched before 'com', causing 'gmail.com' to become 'gmail.co')
    //
    // BG-13 FIX (2026-05-10): extended with common ICANN TLDs the previous list
    // missed — `.edu` / `.gov` / `.museum` are stable government / institutional
    // gTLDs whose absence meant emails on those domains were never trimmed of
    // trailing garbage attached by HTML extractors. Also added the most common
    // EU ccTLDs (`.ch` `.at` `.nl` `.be`) and modern gTLDs the project meets in
    // the Italian SMB landscape (`.online` `.store` `.studio` `.agency`
    // `.cloud` `.ai`). Ordering still LENGTH DESC (longest first).
    const validTLDs = [
        'museum', 'online', 'agency', 'studio',                           // 6 char
        'cloud', 'store',                                                 // 5 char
        'info', 'name', 'mobi', 'tech', 'shop', 'site',                   // 4 char
        'com', 'org', 'net', 'edu', 'gov', 'biz', 'pro', 'app', 'dev',    // 3 char
        'it', 'de', 'fr', 'es', 'ch', 'at', 'nl', 'be',                   // 2 char EU ccTLDs
        'uk', 'eu', 'io', 'ai', 'co', 'me', 'tv',                         // 2 char misc
    ];

    // User provided regex
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

    // Simple deobfuscation
    let textContent = html
        .replace(/\s*\[at\]\s*/gi, '@')
        .replace(/\s*\(at\)\s*/gi, '@')
        .replace(/\s*\[dot\]\s*/gi, '.')
        .replace(/\s*\(dot\)\s*/gi, '.');

    const matches = textContent.match(emailRegex) || [];

    matches.forEach(rawEmail => {
        let clean = rawEmail.toLowerCase().trim();

        // BUG-4 / OBS-3 backport: strip Italian CF (16-char) or P.IVA
        // (11-digit) prefix that DOM-text concatenation may have fused
        // into the local-part. Must run BEFORE phone-prefix cleanup
        // because phone cleanup is leading-digit only and would skip
        // CF (which starts with letters).
        clean = _stripIdentifierPrefix(clean);

        // FIX-004: Remove unicode escape prefixes (u003e = >)
        clean = clean.replace(/^u003[ce]/gi, '');

        // FIX-005: Remove URL-encoded space prefix
        clean = clean.replace(/^%20/, '');

        // FIX-005: Remove phone number prefixes (02-66106053info@ -> info@)
        clean = clean.replace(/^[\d.\-]{1,15}(?=[a-zA-Z])/, '');

        // FIX-005: Remove text label prefixes
        clean = clean.replace(/^(information|informazioni|italia|italy)(?=[a-z])/i, '');

        // FIX-004: Remove leading dots
        clean = clean.replace(/^\.+/, '');

        // CRITICAL FIX-007: Process multi-extension FIRST to handle over-captured emails
        // The emailRegex can over-capture text after the TLD (e.g., "gmail.comContattaci")
        // This regex extracts just the valid email by matching up to a known TLD
        // TLDs are ordered by LENGTH DESC to prevent .com → .co truncation!
        const multiExtMatch = clean.match(/^(.+@[a-zA-Z0-9.-]+\.(?:info|name|mobi|tech|shop|site|online|store|com|org|net|edu|gov|biz|pro|app|dev|it|de|fr|es|nl|ch|at|be|uk|eu|us|ca|io|co|me|tv))(?:[^a-zA-Z].*)?$/i);
        if (multiExtMatch && multiExtMatch[1]) {
            clean = multiExtMatch[1];
        }

        // FIX-004: Clean corrupted TLD suffix (backup for edge cases)
        const parts = clean.split('@');
        if (parts.length === 2) {
            const [localPart, domainPart] = parts;
            const domainSegments = domainPart.split('.');
            if (domainSegments.length >= 2) {
                const currentTLD = domainSegments[domainSegments.length - 1];
                if (!validTLDs.includes(currentTLD)) {
                    for (const validTLD of validTLDs) {
                        if (currentTLD.startsWith(validTLD) && currentTLD.length > validTLD.length) {
                            domainSegments[domainSegments.length - 1] = validTLD;
                            clean = `${localPart}@${domainSegments.join('.')}`;
                            break;
                        }
                    }
                }
            }
        }

        // FIX-005: Validate local part and domain
        const localPart = clean.split('@')[0] || '';
        const domain = clean.split('@')[1] || '';

        // Filter: single-char or numeric-only local part
        if (localPart.length <= 1 || /^\d+$/.test(localPart)) {
            return;
        }

        // Filter: www. in domain
        if (domain.startsWith('www.')) {
            return;
        }

        // Basic filter + FIX-003: Blacklist check
        const isBlacklisted = emailBlacklist.some(d => domain === d || domain.endsWith('.' + d));
        if (!clean.endsWith('.png') && !clean.endsWith('.jpg') && !isBlacklisted && clean.includes('@')) {
            emails.add(clean);
        }
    });

    // Extract social links
    const socialLinks = {
        facebook: html.match(/facebook\.com\/[^"\s]+/)?.[0] || null,
        instagram: html.match(/instagram\.com\/[^"\s]+/)?.[0] || null,
        twitter: html.match(/(twitter|x)\.com\/[^"\s]+/)?.[0] || null,
        linkedin: html.match(/linkedin\.com\/[^"\s]+/)?.[0] || null
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // ITALIAN B2B FEATURE: Extract Partita IVA and Codice Fiscale
    // CRITICAL FIX: This was completely missing, causing 88% P.IVA loss!
    // ═══════════════════════════════════════════════════════════════════════════
    const italianTaxCodes = { partitaIva: null, codiceFiscale: null };

    // Partita IVA — shared SSOT (lib/partitaIva.js): checksum-validated, handles
    // composite labels like "P.IVA/C.F. NNN" / "Cod.Fisc./Part.IVA/... NNN".
    italianTaxCodes.partitaIva = extractPartitaIva(textContent);
    if (italianTaxCodes.partitaIva) logger.info(`[FALLBACK] ✓ Found P.IVA: ${italianTaxCodes.partitaIva}`);

    // Codice Fiscale pattern (16 alphanumeric chars with Italian structure)
    const cfPattern = /(?:C\.?\s*F\.?|Codice\s*Fiscale|Fiscal\s*Code)[:\s]*([A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z])\b/gi;
    cfPattern.lastIndex = 0;
    const cfMatch = cfPattern.exec(textContent.toUpperCase());
    if (cfMatch && cfMatch[1]) {
        italianTaxCodes.codiceFiscale = cfMatch[1].toUpperCase();
        logger.info(`[FALLBACK] ✓ Found C.F.: ${cfMatch[1]}`);
    }

    return {
        url,
        emails: Array.from(emails),
        socialLinks,
        italianTaxCodes,  // ← CRITICAL FIX: Now included!
        title: ''
    };
}

/**
 * Wrapper: Setup offscreen document using offscreen-manager module
 */
async function setupOffscreenDocument() {
    return await setupOffscreenDocumentModule();
}

/**
 * Wrapper: Ensure offscreen ready using offscreen-manager module
 */
async function ensureOffscreenReady() {
    return await ensureOffscreenReadyModule();
}

/**
 * Wrapper: Export data as CSV using data-exporter module
 */
async function exportData() {
    return await exportDataModule();
}

/**
 * Wrapper: Export emails as Markdown using data-exporter module
 */
async function exportEmailsMarkdown() {
    return await exportEmailsMarkdownModule();
}

/**
 * Wrapper: Export URLs using data-exporter module
 */
async function exportUrls() {
    return await exportUrlsModule();
}

/**
 * Get stats including queue status
 */
async function getStatsWithQueue() {
    try {
        const dbStats = await getStats();
        const queueStatus = jobQueue.getStatus();

        return {
            ...dbStats,
            queue: queueStatus.pending,
            active: queueStatus.active,
            queueStats: queueStatus.stats
        };
    } catch (error) {
        logger.error('Failed to get stats:', error);
        throw error;
    }
}

/**
 * Clear all data
 */
async function clearAllData() {
    try {
        await clearAllBusinesses();

        // Also clear in-memory cache if any (though we rely on DB mostly)
        // Reset job queue
        jobQueue.clear();

        logger.info('All data cleared from database and queue');
        return { status: 'cleared' };
    } catch (error) {
        logger.error('Failed to clear data:', error);
        throw error;
    }
}

/**
 * Get businesses that failed email scraping FROM DATABASE
 * These are businesses where:
 * - emailScraped = true (we tried)
 * - email is empty/null (we didn't find one)
 * - website exists (so we can retry)
 */
async function getFailedBusinessesFromDB() {
    try {
        const allBusinesses = await getBusinesses();

        const failed = allBusinesses.filter(business => {
            const wasScraped = business.emailScraped === true;
            const hasNoEmail = !business.email || business.email.trim() === '';
            const hasWebsite = business.website && business.website.trim() !== '';
            const isNotSkipped = business.scrapedFrom !== 'skipped_invalid_url';

            return wasScraped && hasNoEmail && hasWebsite && isNotSkipped;
        });

        logger.info(`Found ${failed.length} failed businesses in database`);
        return failed;
    } catch (error) {
        logger.error('Error getting failed businesses:', error);
        return [];
    }
}

/**
 * Get count of failed businesses
 */
async function getFailedBusinessesCount() {
    const failed = await getFailedBusinessesFromDB();
    return {
        count: failed.length,
        categories: categorizeFailures(failed)
    };
}

/**
 * Categorize failures by type
 */
function categorizeFailures(businesses) {
    const categories = {
        noEmail: 0,
        cloudflare: 0,
        timeout: 0,
        error: 0
    };

    businesses.forEach(b => {
        const error = (b.scrapeError || '').toLowerCase();
        if (error.includes('cloudflare')) {
            categories.cloudflare++;
        } else if (error.includes('timeout')) {
            categories.timeout++;
        } else if (error) {
            categories.error++;
        } else {
            categories.noEmail++;
        }
    });

    return categories;
}

/**
 * Factory Reset - Complete wipe of all data
 * Returns the extension to fresh install state
 */
async function factoryReset() {
    logger.info('🔴 FACTORY RESET INITIATED');

    try {
        // ═══════════════════════════════════════════════════════════════════════════
        // C3-002 FIX: Factory Reset Await - Ensure all operations complete
        // ─────────────────────────────────────────────────────────────────────────────
        // Problem: Previously jobQueue.stop() was NOT awaited, causing:
        // - Active jobs might continue during reset
        // - Data could be partially cleared
        // - User thinks reset is done but old data persists
        // 
        // Solution: Await stop() to ensure all active jobs complete before clearing
        // ═══════════════════════════════════════════════════════════════════════════

        // Step 1: Stop any active scraping - AWAIT required!
        logger.info('[RESET] Step 1: Stopping active jobs...');
        if (jobQueue) {
            await jobQueue.stop();  // C3-002 FIX: Was missing await - stop() is async!
            jobQueue.clear();       // clear() is sync, no await needed
            // FIX: Reset isPaused flag so new jobs can auto-start after reset
            jobQueue.isPaused = false;
        }
        stopKeepAlive();

        // Step 2: Clear businesses from database first
        logger.info('[RESET] Step 2: Clearing businesses...');
        try {
            await clearAllBusinesses();
        } catch (e) {
            logger.warn('Could not clear businesses:', e.message);
        }

        // Step 3: Delete the IndexedDB database completely
        logger.info('[RESET] Step 3: Deleting IndexedDB...');
        await deleteIndexedDB();

        // Step 4: Clear chrome.storage.local
        logger.info('[RESET] Step 4: Clearing chrome.storage.local...');
        await chrome.storage.local.clear();

        // Step 5: Clear chrome.storage.sync (if used)
        logger.info('[RESET] Step 5: Clearing chrome.storage.sync...');
        try {
            await chrome.storage.sync.clear();
        } catch (e) {
            logger.warn('Could not clear sync storage:', e.message);
        }

        // Step 6: Clear chrome.storage.session (if available, MV3)
        logger.info('[RESET] Step 6: Clearing chrome.storage.session...');
        try {
            if (chrome.storage.session) {
                await chrome.storage.session.clear();
            }
        } catch (e) {
            logger.warn('Could not clear session storage:', e.message);
        }

        // Step 7: Reset in-memory state
        logger.info('[RESET] Step 7: Resetting in-memory state...');
        totalEmailJobs = 0;
        completedEmailJobs = 0;
        currentBusinessName = '';
        _schedulePersistEmailProgress();  // BG-4: persist the cleared state

        // BUG-016 FIX: Reset Statistics and SessionPool singletons
        logger.info('[RESET] Step 7b: Resetting Statistics singleton...');
        try {
            resetStatistics();
        } catch (e) {
            logger.warn('Could not reset Statistics:', e.message);
        }

        logger.info('[RESET] Step 7c: Resetting SessionPool singleton...');
        try {
            resetSessionPool();
        } catch (e) {
            logger.warn('Could not reset SessionPool:', e.message);
        }

        // ARCH-002 FIX: Reset AutoScaler singleton
        logger.info('[RESET] Step 7d: Resetting AutoScaler singleton...');
        try {
            const { resetAutoScaler } = await import('../lib/AutoScaler.js');
            resetAutoScaler();
        } catch (e) {
            logger.warn('Could not reset AutoScaler:', e.message);
        }

        // ARCH-002 FIX: Clear SystemMonitor history
        logger.info('[RESET] Step 7e: Clearing SystemMonitor history...');
        try {
            const monitor = getSystemMonitor();
            if (monitor && typeof monitor.clearHistory === 'function') {
                monitor.clearHistory();
            }
        } catch (e) {
            logger.warn('Could not clear SystemMonitor:', e.message);
        }

        // Step 8: Reinitialize database with fresh ID
        logger.info('[RESET] Step 8: Reinitializing database...');
        try {
            await initDB();
        } catch (e) {
            logger.warn('Could not reinitialize DB:', e.message);
        }

        logger.info('✅ FACTORY RESET COMPLETE - Extension is now fresh!');

        // Broadcast reset complete
        broadcastMessage({
            action: 'reset_complete',
            payload: { timestamp: Date.now() }
        });

        return {
            status: 'success',
            message: 'Factory reset complete. Extension is now fresh.'
        };

    } catch (error) {
        logger.error('Factory reset failed:', error);
        // P1-3 FIX: Use serializeError for proper error serialization
        // Preserves stack trace in development mode for debugging
        const { serializeError } = await import('../lib/utils.js');
        return {
            status: 'error',
            error: serializeError(error)
        };
    }
}

/**
 * Delete IndexedDB database completely
 */
async function deleteIndexedDB() {
    return new Promise((resolve, reject) => {
        // Possible database names to try
        const possibleNames = [
            'GhostMapDB',
            'GhostMapDB_Dev',
            'GhostMapPro',
            'ghost_map_pro',
            CONFIG.db?.name
        ].filter(Boolean);

        // Try to get stored dbId
        chrome.storage.local.get('dbId', (result) => {
            if (result.dbId) {
                possibleNames.push('AppDataStore_' + result.dbId);
                possibleNames.push('GhostMapDB_' + result.dbId);
            }

            let completedCount = 0;
            const expectedCount = possibleNames.length;

            // Try to delete all possible database names
            possibleNames.forEach(name => {
                try {
                    const deleteRequest = indexedDB.deleteDatabase(name);

                    deleteRequest.onsuccess = () => {
                        logger.info(`✅ Deleted IndexedDB: ${name}`);
                        completedCount++;
                        if (completedCount >= expectedCount) {
                            resolve();
                        }
                    };

                    deleteRequest.onerror = (event) => {
                        logger.warn(`Could not delete ${name}:`, event.target?.error);
                        completedCount++;
                        if (completedCount >= expectedCount) {
                            resolve();
                        }
                    };

                    deleteRequest.onblocked = () => {
                        logger.warn(`Database ${name} delete blocked`);
                        // Try again after a delay
                        setTimeout(() => {
                            indexedDB.deleteDatabase(name);
                        }, 100);
                    };
                } catch (e) {
                    logger.warn(`Error deleting ${name}:`, e);
                    completedCount++;
                    if (completedCount >= expectedCount) {
                        resolve();
                    }
                }
            });

            // Timeout fallback
            setTimeout(() => {
                logger.info(`IndexedDB cleanup completed: ${completedCount}/${expectedCount}`);
                resolve();
            }, 1000);
        });
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// ARCH-004 FIX: Broadcast Rate Limiter with Circuit Breaker
// Prevents message queue overflow during high-volume operations
// ═══════════════════════════════════════════════════════════════════════════════
const BROADCAST_LIMITER = {
    lastSendTime: new Map(),      // action → timestamp
    minIntervalMs: 100,           // Max 10 messages/sec per action type
    consecutiveFailures: 0,
    maxFailures: 5,
    circuitOpen: false,
    circuitOpenTime: null,
    circuitCooldownMs: 30000,     // 30 seconds

    shouldSend(action) {
        // Check circuit breaker first
        if (this.circuitOpen) {
            if (Date.now() - this.circuitOpenTime > this.circuitCooldownMs) {
                this.circuitOpen = false;
                this.consecutiveFailures = 0;
                logger.info('[BROADCAST] Circuit breaker reset');
            } else {
                return false;
            }
        }

        // Rate limit per action type
        const last = this.lastSendTime.get(action) || 0;
        if (Date.now() - last < this.minIntervalMs) {
            return false; // Too soon, skip this message
        }
        this.lastSendTime.set(action, Date.now());
        return true;
    },

    recordFailure() {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.maxFailures && !this.circuitOpen) {
            this.circuitOpen = true;
            this.circuitOpenTime = Date.now();
            logger.error(`[BROADCAST] Circuit breaker OPEN after ${this.maxFailures} consecutive failures`);
        }
    },

    recordSuccess() {
        this.consecutiveFailures = 0;
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// UX-1 FIX (2026-05-15): Phase-2 progress heartbeat.
// Pre-fix the UI received `scraping_progress` only on email_found / job_complete.
// During slow stretches (tab-fallback cascades, circuit-breaker pauses, AutoScaler
// scale-down) the user saw a stalled bar for 30-60s and assumed the SW had frozen.
// The heartbeat ticks every 2s during an active phase-2 batch, emitting a payload
// that always reflects current queue state — including `circuitOpen`, so the UI
// can show "⚠️ Troppi siti falliscono — pausa di 60s" instead of a silent freeze.
// Cleanup: explicit stop in onQueueEmpty + stopEmailScraping so no zombie interval
// survives SW eviction/resurrection cycles.
// ═══════════════════════════════════════════════════════════════════════════════
let _phase2HeartbeatId = null;
const PHASE2_HEARTBEAT_INTERVAL_MS = 2000;

function _emitPhase2Heartbeat() {
    try {
        const status = jobQueue.getStatus();
        broadcastMessage({
            action: 'phase2_heartbeat',
            payload: {
                processed: completedEmailJobs,
                total: totalEmailJobs,
                active: status.active,
                pending: status.pending,
                failed: status.failed,
                isPaused: status.isPaused,
                circuitOpen: status.circuitOpen,
                autoScalerConcurrency: jobQueue.autoScaler?.getConcurrency?.() ?? null,
                activeNames: _currentBusinessNamesDisplay(),
                timestamp: Date.now()
            }
        });
    } catch (err) {
        logger.debug('[HEARTBEAT] emit skipped:', err?.message || String(err));
    }
}

function _startPhase2Heartbeat() {
    if (_phase2HeartbeatId !== null) return;  // already running, idempotent
    _phase2HeartbeatId = setInterval(_emitPhase2Heartbeat, PHASE2_HEARTBEAT_INTERVAL_MS);
    _emitPhase2Heartbeat();  // emit once immediately so UI updates instantly
    logger.info('[HEARTBEAT] phase-2 heartbeat started (2s interval)');
}

function _stopPhase2Heartbeat() {
    if (_phase2HeartbeatId === null) return;
    clearInterval(_phase2HeartbeatId);
    _phase2HeartbeatId = null;
    logger.info('[HEARTBEAT] phase-2 heartbeat stopped');
}

/**
 * Broadcast message to all extension contexts
 * BUG-003 FIX: Validates message size and differentiates between error types
 * ARCH-004 FIX: Added rate limiting with circuit breaker
 * @param {Object} message - Message to broadcast
 */
function broadcastMessage(message) {
    // ARCH-004 FIX: Rate limit check
    const action = message.action || 'unknown';
    if (!BROADCAST_LIMITER.shouldSend(action)) {
        logger.debug(`[BROADCAST] Rate limited: ${action}`);
        return;
    }

    // BUG-003 FIX: Check message size before sending to prevent silent data loss
    const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB safe limit
    try {
        const messageSize = JSON.stringify(message).length;
        if (messageSize > MAX_MESSAGE_SIZE) {
            logger.error(`[BROADCAST] Message too large (${messageSize} bytes > ${MAX_MESSAGE_SIZE}). Data may be lost.`);
            // Truncate payload if possible
            if (message.payload && Array.isArray(message.payload.businesses)) {
                const truncatedCount = Math.floor(message.payload.businesses.length / 2);
                message.payload.businesses = message.payload.businesses.slice(0, truncatedCount);
                logger.warn(`[BROADCAST] Truncated businesses to ${truncatedCount} items`);
            }
        }
    } catch (sizeError) {
        logger.warn('[BROADCAST] Could not estimate message size:', sizeError.message);
    }

    chrome.runtime.sendMessage(message).then(() => {
        BROADCAST_LIMITER.recordSuccess();
    }).catch(err => {
        const errorMsg = err?.message || String(err);
        // BUG-003 FIX: Differentiate between benign and critical errors
        if (errorMsg.includes('Could not establish connection') ||
            errorMsg.includes('Receiving end does not exist')) {
            // Benign: No listeners (UI not open) - don't trigger circuit breaker
            logger.debug('Broadcast failed (no listeners):', errorMsg);
        } else if (errorMsg.includes('Extension context invalidated')) {
            // Critical: Service worker is dying
            logger.error('[BROADCAST] Extension context invalidated - service worker may be terminating');
            BROADCAST_LIMITER.recordFailure();  // ARCH-004 FIX: Trigger circuit breaker
        } else if (errorMsg.includes('Message too large') || errorMsg.includes('QUOTA_EXCEEDED')) {
            // Critical: Data loss
            logger.error('[BROADCAST] Message too large - data loss occurred:', errorMsg);
            BROADCAST_LIMITER.recordFailure();  // ARCH-004 FIX: Trigger circuit breaker
        } else {
            // Unknown error - conservative: trigger circuit breaker
            logger.warn('[BROADCAST] Unknown broadcast error:', errorMsg);
            BROADCAST_LIMITER.recordFailure();  // ARCH-004 FIX: Trigger circuit breaker
        }
    });
}

/**
 * H3-001 FIX VERIFIED: Service Worker Keep-Alive Prevention
 * ═══════════════════════════════════════════════════════════════════════════
 * Chrome terminates service workers after 30s of inactivity.
 * This mechanism prevents termination during long-running operations:
 * 
 * Architecture:
 * - Uses chrome.alarms API (0.33 min = 20s) for reliable wake-up
 * - Sends heartbeat message on each alarm tick
 * - 33% safety margin before 30s Chrome timeout
 * 
 * Integration:
 * - startKeepAlive() called in startEmailScraping() (line ~888)
 * - stopKeepAlive() called in onQueueEmpty callback (line ~257)
 * - stopKeepAlive() called in stopEmailScraping() (line ~1478)
 * 
 * AUDIT FIX #4: Reduced interval to 20s for 33% safety margin
 * Chrome shuts down service workers after 30s of inactivity
 * ═══════════════════════════════════════════════════════════════════════════
 */
// ═══════════════════════════════════════════════════════════════════════════
// B1-1 P0 FIX: keepalive alarm clamping + first-fire race
// ─────────────────────────────────────────────────────────────────────────
// Pre-fix: chrome.alarms.create('keepalive', { periodInMinutes: 0.33 }).
// Two bugs:
//   1. Chrome production clamps `periodInMinutes` minimum to 0.5 (30s),
//      so the comment "20s interval" was false — real interval was 30s+,
//      not the 33% safety margin claimed.
//   2. Without `delayInMinutes`, first fire was scheduled at periodInMinutes
//      from creation = 30s+. Race window: SW could die at 30s of inactivity
//      BEFORE the first keepalive tick.
//
// Plus: the self-ping `chrome.runtime.sendMessage({action:'heartbeat'})` is
// an undocumented hack — Chrome may break it silently in future versions.
//
// Fix:
//   - delayInMinutes: 0.5 (first fire at 30s — entry into safety window)
//   - periodInMinutes: 0.5 (clamped minimum — explicit, not silently)
//   - Replace self-ping with chrome.runtime.getPlatformInfo() — DOCUMENTED
//     pattern that resets the SW idle timer.
//
// Reference: docs/HANDOFF_ULTRAREVIEW_BLOCKS.md Block 1 §B1-1
// ═══════════════════════════════════════════════════════════════════════════
function startKeepAlive() {
    // B1-1 fix: 0.5min = 30s, the documented MV3 minimum.
    // delayInMinutes ensures first fire enters the safety window;
    // without it the first tick would be 30s out, racing with eviction.
    chrome.alarms.create('keepalive', {
        delayInMinutes: 0.5,
        periodInMinutes: 0.5
    });
    logger.debug('[KEEPALIVE] Started: delay 30s, period 30s');

    // Immediate platform-info call resets the SW idle timer right now —
    // documented Chrome behavior, doesn't rely on undocumented sendMessage hack.
    chrome.runtime.getPlatformInfo().catch(() => { });
}

function stopKeepAlive() {
    chrome.alarms.clear('keepalive');
    logger.debug('[KEEPALIVE] Stopped');
}

// Listen for keepalive alarm. On each tick, call chrome.runtime.getPlatformInfo()
// — a cheap, async, DOCUMENTED API call that resets the idle timer. Replaces
// the undocumented self-ping sendMessage hack.
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
        // B1-1 fix: documented idle-reset pattern (vs sendMessage self-ping).
        chrome.runtime.getPlatformInfo().catch(() => {
            // Ignore — keepalive is best-effort
        });
        logger.debug('[KEEPALIVE] Idle timer reset via getPlatformInfo');
    }
});

/**
 * CRAWLEE PHASE 2.2 + 3.3: Graceful shutdown handler
 * Persists session state and queue before service worker suspends
 *
 * BG-6 FIX (2026-05-10): Chrome MV3 does NOT await the Promise returned
 * by an async chrome.runtime.onSuspend listener — the SW is forcibly
 * terminated ~5 s after the event fires regardless of pending work. The
 * pre-fix `await shutdownInfrastructure(...)` was effectively fire-and-
 * forget; if persistence took longer than the unobserved budget, in-
 * flight chrome.storage.* writes were aborted mid-flight, leaving the
 * B6-1 job ledger and SessionPool snapshot inconsistent. Recovery on
 * next wake then re-enqueued jobs that were actually mid-execution and
 * minted fresh session fingerprints, breaking anti-detection continuity.
 *
 * Fix: race against a self-imposed 4 s budget (1 s safety margin under
 * Chrome's ~5 s ceiling) and surface which path won. We can't make
 * Chrome wait, but we CAN make the persistence loop stop attempting new
 * writes if we've already used the budget — preserves partial progress
 * instead of starting writes that would be torn down.
 */
const SUSPEND_BUDGET_MS = 4000;
chrome.runtime.onSuspend?.addListener?.(() => {
    logger.info('[SHUTDOWN] Service worker suspending, persisting state...');
    // NOTE: we deliberately do NOT mark the listener `async`. Returning
    // void here is more honest about Chrome's actual contract — there is
    // no awaiter on the other side. The IIFE below runs but Chrome may
    // tear down the SW before it resolves.
    (async () => {
        const startedAt = Date.now();
        const budgetPromise = new Promise((resolve) =>
            setTimeout(() => resolve({ kind: 'budget_exhausted' }), SUSPEND_BUDGET_MS)
        );
        const shutdownPromise = (async () => {
            try {
                await shutdownInfrastructure({
                    jobQueue,
                    systemMonitor: getSystemMonitor(),
                    autoScaler: getAutoScaler(),
                    // BUG-3 + DEBT-3 (2026-05-27): pass the frozen namespace
                    // exported by CircuitBreaker.js. Post-DEBT-3 this is a
                    // proper Object.freeze({...public fns}) — distinct from
                    // `_circuitBreakerStateMap` (the raw Map) — so the
                    // BUG-3 trap (mistakenly passing the Map) is structurally
                    // impossible at the import site. The defensive warn in
                    // shutdownInfrastructure stays as belt-and-suspenders.
                    circuitBreaker,
                    sessionPool: { shutdown: shutdownSessionPool }
                });
                return { kind: 'completed' };
            } catch (error) {
                return { kind: 'errored', message: error?.message || String(error) };
            }
        })();

        const winner = await Promise.race([shutdownPromise, budgetPromise]);
        const elapsed = Date.now() - startedAt;

        if (winner.kind === 'completed') {
            logger.info(`[SHUTDOWN] All state persisted successfully (${elapsed} ms)`);
        } else if (winner.kind === 'errored') {
            logger.warn(`[SHUTDOWN] Persistence errored after ${elapsed} ms: ${winner.message}`);
        } else {
            logger.warn(
                `[SHUTDOWN] Budget exhausted after ${SUSPEND_BUDGET_MS} ms — ` +
                `partial state may be persisted; in-flight writes may be torn down by Chrome`
            );
        }
    })();
});

/**
 * Ensure offscreen document is ready to receive messages
 */

// Keep alive managed by queue callbacks in setupQueueCallbacks()

logger.info('Background service worker ready');

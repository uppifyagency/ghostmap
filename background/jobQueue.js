/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Job Queue
 * Advanced queue with rate limiting, retry logic, and priority scheduling
 */

import { CONFIG } from '../lib/config.js';
import { logger, sleep, randomDelay, serializeError } from '../lib/utils.js';
import { getAutoScaler } from '../lib/AutoScaler.js';
import { Mutex } from '../lib/mutex.js';
import { getSystemMonitor } from '../lib/SystemMonitor.js';
import { createSessionState } from '../lib/swState.js';

// BG-7 FIX (2026-05-10): module-scope persisted circuit-breaker state for
// the JobQueue. Pre-fix `this.consecutiveFailures`, `this.circuitOpen`,
// `this.circuitOpenTime` were constructor-instance fields. On SW eviction
// the JobQueue instance is re-created by background/index.js boot and the
// values reset to defaults — the cooldown that was meant to last 60 s
// effectively lasted only until the next eviction (often seconds), so
// after an outage burst the queue resumed hammering the failing endpoint
// immediately. We persist the three values to chrome.storage.session and
// rehydrate them on construction (synchronously load via `get()` post-
// constructor — see _restoreCircuitOnce below).
const _jqCircuitState = createSessionState('jobqueue_circuit.v1', {
    consecutiveFailures: 0,
    circuitOpen: false,
    circuitOpenTime: null,
});

export class JobQueue {
    // M4-MISS1: Maximum size for failedJobs array to prevent unbounded growth
    static MAX_FAILED_JOBS = 500;
    // M4-MISS2: Stale domain token threshold (1 hour)
    static DOMAIN_TOKEN_STALE_MS = 60 * 60 * 1000;

    constructor(options = {}) {
        this.queue = [];
        // JQ-01 FIX (2026-06-09): Map<jobId, job>, not Set<jobId>. saveQueue()
        // serializes union(activeJobs, queue) via `this.activeJobs.values()` and
        // filters by `job.persistable && job.type` — when this held bare id
        // strings the filter dropped every entry, so in-flight jobs were never
        // persisted and a browser crash/restart lost them (the whole
        // union-persist block was dead code). Storing the job object makes it live.
        this.activeJobs = new Map();
        this.failedJobs = [];
        this.mutex = new Mutex();
        // BUG-023 FIX: Validate test mode is only used in test environments
        this.testMode = options.testMode ?? false;
        // BLOCK-1 FIX: Use globalThis instead of window (service workers don't have window)
        // BGW-M2 FIX: Use logger.debug instead of console.warn to avoid console noise in production
        // This warning is only useful for developers who accidentally enable testMode
        if (this.testMode && typeof globalThis !== 'undefined' && !globalThis.__TEST_MODE__) {
            logger.debug('[JobQueue] testMode enabled outside of test environment - delays will be disabled');
        }

        // Configuration
        // PHASE 2: AutoScaler integration for dynamic concurrency control.
        // Forensic #9 (2026-06-11): use the PURE accessor. The authoritative
        // config (min1/max5/desired3) is set once by index.js initialize() via
        // configureAutoScaler(). Pre-fix this constructor passed min2/max8 — but
        // it was silently ignored anyway (an eager no-option getAutoScaler() in
        // email-scraper-v2.js had already created the default instance), so the
        // live scaler ran defaults (max 10). The run loop reads
        // autoScaler.getConcurrency() live (see ~:546), so the authoritative
        // reconfigure that lands during initialize() is honored at runtime.
        this.autoScaler = getAutoScaler();
        this.maxConcurrent = this.autoScaler.getConcurrency();


        // AUDIT FIX #8: Gaussian delay parameters
        this.meanDelayMs = CONFIG.rateLimits.emailScraping.meanDelayMs;
        this.jitterStdDev = CONFIG.rateLimits.emailScraping.jitterStdDev;

        // Burst limiting (AUDIT FIX #8)
        this.burstLimit = CONFIG.rateLimits.emailScraping.burstLimit;
        this.burstCooldownMs = CONFIG.rateLimits.emailScraping.burstCooldownMs;
        this.requestsInBurst = 0;
        this.lastBurstReset = Date.now();

        // Circuit breaker
        this.consecutiveFailures = 0;
        this.circuitOpen = false;
        this.circuitOpenTime = null;
        this._circuitPersistTimer = null;
        this._circuitRestored = false;
        // BG-7: rehydrate from chrome.storage.session if a prior SW
        // instance left a persisted snapshot. Async; readers before
        // restore completes see the constructor defaults (acceptable
        // since circuit checks always re-validate against the live
        // clock — at worst we briefly process one extra job that the
        // pre-eviction breaker would have blocked).
        this._restoreCircuitOnce();

        // Status
        this.isProcessing = false;
        this.isPaused = false;
        this.stats = {
            processed: 0,
            succeeded: 0,
            failed: 0,
            retried: 0
        };

        // Callbacks
        this.onQueueEmpty = null;
        this.onJobComplete = null;
        this.onJobFailed = null;

        // Per-domain rate limiting
        this.domainTokens = new Map(); // domain -> { tokens, lastRefill }
        this.domainRateLimit = 5; // Max 5 requests per domain per minute (conservative)

        // PHASE 3 FIX #30: Domain retry budgets to prevent hammering failed domains
        this.domainRetryBudgets = new Map(); // domain -> { count, resetAt }
        this.maxRetryPerDomain = CONFIG.limits.DOMAIN_RETRY_BUDGET; // PHASE 4 FIX #38: Use config constant
        this.retryBudgetWindowMs = CONFIG.limits.DOMAIN_RETRY_WINDOW_MS; // PHASE 4 FIX #38: Use config constant

        // ═══════════════════════════════════════════════════════════════════════════════
        // CRAWLEE FEATURE 1.3: Same Domain Delay
        // ═══════════════════════════════════════════════════════════════════════════════
        this.lastDomainRequest = new Map(); // domain -> timestamp
        // BUG-JQ-Falsy-Defaults (jobQueue audit, 2026-05-09): same `||` →
        // `??` pattern as AutoScaler / Statistics audits. `||` would override
        // legitimate caller intent of `0` (e.g. sameDomainDelayMs: 0 to
        // disable, backoffBase: 0 for instant retry). Use `??` to honor
        // explicit zeros.
        // Test: tests/run-jobqueue-pure-logic-node.mjs (Test 1).
        this.sameDomainDelayMs = options.sameDomainDelayMs ?? 2000; // Default 2 seconds between same-domain requests

        // CRAWLEE FEATURE 1.5: Enhanced Backoff
        this.backoffBase = options.backoffBase ?? 1000; // 1 second base
        this.backoffMax = options.backoffMax ?? 30000; // 30 seconds max
        this.backoffJitterPercent = options.backoffJitterPercent ?? 0.25; // ±25% jitter

        // BGW-H2 FIX: Timer registry to prevent orphaned timers
        this._pendingTimers = new Set();

        // M2-RACE1 FIX: Cancellation token for addJobsInBatches
        this._cancellationRequested = false;

        // M4-BUG1 FIX: Flag to track jobs added while processQueue holds the mutex
        // Prevents TOCTOU race where add() -> start() -> _processQueue() hits
        // the isLocked guard and the new job is silently dropped
        this._jobsAddedDuringProcessing = false;

        // M4-MISS2: Periodic cleanup of stale domainTokens (every 10 minutes)
        this._domainTokenCleanupInterval = setInterval(() => this.cleanupStaleDomainTokens(), 10 * 60 * 1000);

        logger.info(`[JobQueue] 🚀 Initialized with Crawlee features: sameDomainDelay=${this.sameDomainDelayMs}ms, backoffMax=${this.backoffMax}ms`);
        // Forensic #9 (2026-06-11): read the live scaler instead of the old
        // hardcoded min=2/max=8 + the now-removed `initialConcurrent` local
        // (which had become a dangling ReferenceError after the eager-config
        // removal — it crashed real-module import in probe_audit). The
        // authoritative config is applied by index.js configureAutoScaler().
        logger.info(`[JobQueue] 🎚️ AutoScaler enabled: min=${this.autoScaler.options.minConcurrency}, max=${this.autoScaler.options.maxConcurrency}, initial=${this.autoScaler.getConcurrency()}`);
    }

    /**
     * Add job to queue
     */
    add(jobFunction, options = {}) {
        const job = {
            id: this._generateJobId(),
            fn: jobFunction,
            priority: options.priority || 0,
            retries: 0,
            maxRetries: options.maxRetries || CONFIG.errors.maxRetries,
            addedAt: Date.now(),
            domain: null
        };

        // Safely extract domain if URL is provided
        if (options.url) {
            try {
                // Ensure protocol is present for URL constructor
                let urlStr = options.url;
                if (!urlStr.startsWith('http')) {
                    urlStr = 'https://' + urlStr;
                }
                job.domain = new URL(urlStr).hostname;
            } catch (e) {
                // Fallback if URL is invalid (should be caught upstream, but safety first)
                job.domain = options.domain || 'unknown';
            }
        } else {
            job.domain = options.domain || null;
        }

        this.queue.push(job);

        // Sort by priority (higher priority first)
        this.queue.sort((a, b) => b.priority - a.priority);

        logger.debug(`Job ${job.id} added to queue (priority: ${job.priority})`);

        // M4-BUG1 FIX: If processing is active (mutex held), set dirty flag
        // so _processQueue re-triggers after releasing the mutex.
        // This prevents the TOCTOU race where start() -> _processQueue()
        // hits the isLocked guard and the job is silently dropped.
        if (this.isProcessing || this.mutex.isLocked()) {
            this._jobsAddedDuringProcessing = true;
        }

        // Start processing if not already processing
        if (!this.isProcessing && !this.isPaused) {
            this.start();
        }

        return job.id;
    }

    /**
     * Start processing queue
     * M4-RACE2 FIX: Set isProcessing synchronously to prevent double-start
     * from concurrent resume() + add() calls
     */
    async start() {
        if (this.isProcessing) {
            logger.warn('Queue already processing');
            return;
        }

        // M4-RACE2 FIX: Set isProcessing SYNCHRONOUSLY here to act as an
        // atomic guard. Previously this was only set inside _processQueue
        // after acquiring the mutex, allowing a race window where both
        // resume() and add() could pass the guard before either set the flag.
        this.isProcessing = true;
        this.isPaused = false;
        this._cancellationRequested = false; // M2-RACE1: Reset cancellation on start
        logger.info('Job queue started');

        this._processQueue();
    }

    /**
     * Pause queue processing
     */
    pause() {
        this.isPaused = true;
        logger.info('Job queue paused');
    }

    /**
     * Resume queue processing
     * P0-001 FIX: Use mutex to prevent race condition during resume
     * FIX: Call start() OUTSIDE mutex to prevent deadlock
     */
    resume() {
        if (!this.isPaused) return;

        // P0-001 FIX: Mutex ensures atomic state transition
        this.mutex.runExclusive(() => {
            if (!this.isPaused) return; // Double-check after acquiring lock

            this.isPaused = false;
            logger.info('Job queue resumed');
        }).then(() => {
            // FIX: Schedule start AFTER mutex is released to prevent deadlock
            // _processQueue() needs to acquire mutex, so we can't call it inside mutex
            if (!this.isProcessing && this.queue.length > 0) {
                setTimeout(() => this.start(), 0);
            }
        }).catch(err => {
            logger.error('[QUEUE] Resume mutex error:', err);
        });
    }

    /**
     * Stop queue processing
     * BGW-H2 FIX: Now clears pending timers to prevent orphaned callbacks
     */
    async stop() {
        this.isPaused = true;
        this.isProcessing = false;
        this._jobsAddedDuringProcessing = false; // M4-BUG1: Reset dirty flag on stop
        this._cancellationRequested = true; // M2-RACE1: Signal addJobsInBatches to stop

        // BGW-H2 FIX: Clear all pending timers
        this._clearPendingTimers();

        // Wait for active jobs to complete
        while (this.activeJobs.size > 0) {
            await sleep(100);
        }

        logger.info('Job queue stopped');
    }

    /**
     * M2-RACE1 FIX: Request cancellation of batch additions
     * Called externally to signal addJobsInBatches to stop adding jobs.
     */
    requestCancellation() {
        this._cancellationRequested = true;
        logger.info('[JobQueue] Cancellation requested');
    }

    /**
     * M2-RACE1 FIX: Check if cancellation was requested
     * @returns {boolean}
     */
    isCancellationRequested() {
        return this._cancellationRequested;
    }

    /**
     * M2-RACE1 FIX: Reset the cancellation token (call when starting new batch)
     */
    resetCancellation() {
        this._cancellationRequested = false;
    }

    /**
     * BGW-H2 FIX: Register a timer for tracking
     * @param {NodeJS.Timeout} timerId - Timer ID from setTimeout
     * @returns {NodeJS.Timeout} Same timer ID for chaining
     * @private
     */
    _trackTimer(timerId) {
        this._pendingTimers.add(timerId);
        return timerId;
    }

    /**
     * BG-7 FIX (2026-05-10): write-through persist for circuit-breaker
     * state across SW eviction. Debounced 100 ms so a burst of failure
     * increments coalesces to one storage write.
     * @private
     */
    _schedulePersistCircuit() {
        if (this._circuitPersistTimer) clearTimeout(this._circuitPersistTimer);
        this._circuitPersistTimer = setTimeout(async () => {
            this._circuitPersistTimer = null;
            try {
                await _jqCircuitState.set({
                    consecutiveFailures: this.consecutiveFailures,
                    circuitOpen: this.circuitOpen,
                    circuitOpenTime: this.circuitOpenTime,
                });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.debug(`[JobQueue] persist circuit failed: ${msg}`);
            }
        }, 100);
    }

    /**
     * BG-7 FIX: one-shot rehydrate of circuit state from chrome.storage
     * .session at construction. Async; we don't block the constructor
     * on it (constructors can't await). Concurrent callers that hit the
     * circuit check before restore completes see the defaults (false /
     * 0 / null) — the worst-case outcome is one extra job processed
     * during the ~ms restore window before the persisted "open" flag
     * is honored.
     * @private
     */
    async _restoreCircuitOnce() {
        if (this._circuitRestored) return;
        this._circuitRestored = true;
        try {
            const snap = await _jqCircuitState.get();
            if (snap && typeof snap === 'object') {
                if (typeof snap.consecutiveFailures === 'number'
                    && Number.isFinite(snap.consecutiveFailures)) {
                    this.consecutiveFailures = snap.consecutiveFailures;
                }
                if (typeof snap.circuitOpen === 'boolean') {
                    this.circuitOpen = snap.circuitOpen;
                }
                if (snap.circuitOpenTime === null
                    || (typeof snap.circuitOpenTime === 'number' && Number.isFinite(snap.circuitOpenTime))) {
                    this.circuitOpenTime = snap.circuitOpenTime;
                }
                if (this.circuitOpen) {
                    logger.info(`[JobQueue] Restored circuit state: open=${this.circuitOpen}, ` +
                        `openTime=${this.circuitOpenTime}, consecutiveFailures=${this.consecutiveFailures}`);
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug(`[JobQueue] restore circuit failed: ${msg}`);
        }
    }

    /**
     * BGW-H2 FIX: Unregister a timer (call when timer fires or is cancelled)
     * @param {NodeJS.Timeout} timerId - Timer ID to remove
     * @private
     */
    _untrackTimer(timerId) {
        this._pendingTimers.delete(timerId);
    }

    /**
     * BGW-H2 FIX: Clear all pending timers
     * Called on stop() and shutdown() to prevent orphaned callbacks
     * @private
     */
    _clearPendingTimers() {
        const count = this._pendingTimers.size;
        for (const timerId of this._pendingTimers) {
            clearTimeout(timerId);
        }
        this._pendingTimers.clear();
        if (count > 0) {
            logger.info(`[JobQueue] 🧹 Cleared ${count} pending timers`);
        }
    }

    /**
     * Clear all pending jobs
     */
    clear() {
        // BG-12 FIX (2026-05-10): pre-fix `clear()` only emptied `this.queue`
        // and reset the dirty flag. The retry path at line ~600 schedules a
        // `setTimeout(...)` whose callback does:
        //     if (this.queue.some(j => j.id === retryJobId)) return;
        //     this.queue.unshift(job);
        // The `some()` early-return check was meant to skip re-add when the
        // job was already re-queued, but it does NOT detect "queue was just
        // cleared". On a clear() during a pending retry: queue becomes [],
        // the timer stays alive (clear didn't touch the tracked-timers set),
        // the timer fires, `some()` returns false (empty queue), and the
        // job is unshift-revived — a phantom job appears AFTER clear()
        // completed, contradicting the visible "queue cleared" UI signal.
        // Same applies to the circuit-restart timer scheduled at line ~404
        // (its callback would call `this.start()` on an already-cleared
        // queue, but that one is harmless since the queue is empty).
        // Now: cancel all tracked pending timers as part of clear().
        this._clearPendingTimers();
        this.queue = [];
        this._jobsAddedDuringProcessing = false; // M4-BUG1: Reset dirty flag on clear
        logger.info('Job queue cleared (queue + pending timers)');
    }

    /**
     * Get Gaussian-distributed delay (AUDIT FIX #8)
     * FIX: Reduced minimum from 2000ms to 500ms to allow parallel execution
     * @returns {number} Delay in milliseconds
     */
    _getGaussianDelay() {
        if (this.testMode) return 0; // No delay in test mode

        // Use Box-Muller transform for Gaussian distribution
        const u1 = Math.random();
        const u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

        // Apply mean and standard deviation
        const delay = z0 * this.jitterStdDev + this.meanDelayMs;

        // FIX: Reduced min from 2000 to 500ms, max from 20000 to 5000ms
        // Previous values were too aggressive and blocked parallel execution
        return Math.max(500, Math.min(5000, delay));
    }

    /**
     * Get queue status
     */
    getStatus() {
        return {
            pending: this.queue.length,
            queued: this.queue.length, // Alias for tests
            active: this.activeJobs.size,
            failed: this.failedJobs.length,
            isProcessing: this.isProcessing,
            isPaused: this.isPaused,
            circuitOpen: this.circuitOpen,
            burstCount: this.requestsInBurst,
            burstLimit: this.burstLimit,
            stats: { ...this.stats }
        };
    }

    /**
     * Process queue (internal)
     * AUDIT FIX #8: Gaussian delays + burst limiting for human-like behavior
     * HIGH FIX #4: Proper state management on early exit
     */
    async _processQueue() {
        // Ensure state is always properly managed on early exit (HIGH FIX #4)
        if (this.isPaused) {
            this.isProcessing = false;
            return;
        }

        // Prevent concurrent processing using Mutex (FLAW-005)
        if (this.mutex.isLocked()) {
            logger.debug('[QUEUE] Mutex locked, skipping duplicate processing call');
            return;
        }

        await this.mutex.runExclusive(async () => {
            this.isProcessing = true;

            try {
                // Keep processing if we have jobs in queue OR active jobs running
                while ((this.queue.length > 0 || this.activeJobs.size > 0) && !this.isPaused) {
                    // Check circuit breaker
                    if (this.circuitOpen) {
                        if (Date.now() - this.circuitOpenTime > CONFIG.errors.circuitBreakerTimeout) {
                            logger.info('Circuit breaker cooling period over. Resuming...');
                            this.circuitOpen = false;
                            this.consecutiveFailures = 0;
                            this._schedulePersistCircuit();  // BG-7: persist closed
                        } else {
                            logger.warn('Circuit breaker open. Pausing queue...');
                            // BG-8 FIX (2026-05-10): pre-fix called `this.stop()`
                            // without awaiting. stop() is async — it sets
                            // isPaused, calls `_clearPendingTimers()`, and
                            // awaits each active job. The setTimeout below
                            // was scheduled and tracked synchronously
                            // immediately after, BEFORE stop()'s clear had
                            // run. Result: stop()'s `_clearPendingTimers()`
                            // (line 248) wiped our newly-tracked circuit-
                            // restart timer along with all the others, and
                            // the queue was left without an auto-restart —
                            // a subsequent factoryReset() / clear() also
                            // could not restart since `circuitOpen` was
                            // never closed and no timer was pending.
                            //
                            // Now: await stop() to completion BEFORE
                            // scheduling the restart timer. The timer is
                            // registered AFTER stop() finishes, so it
                            // survives.
                            await this.stop();
                            // Schedule a restart check after timeout
                            const circuitTimerId = setTimeout(() => {
                                this._untrackTimer(circuitTimerId);
                                // After cooldown, circuit should be closable
                                if (this.queue.length > 0 && !this.isPaused) {
                                    logger.info('[QUEUE] Circuit breaker cooldown complete, restarting...');
                                    this.circuitOpen = false;
                                    this.consecutiveFailures = 0;
                                    this._schedulePersistCircuit();  // BG-7: persist closed
                                    this.start();
                                }
                            }, CONFIG.errors.circuitBreakerTimeout + 1000);
                            this._trackTimer(circuitTimerId);
                            break;
                        }
                    }

                    // PHASE 2: Get dynamic concurrency from AutoScaler
                    const dynamicConcurrency = this.autoScaler.getConcurrency();

                    // Check if we can start a new job with dynamic limit
                    if (this.activeJobs.size >= dynamicConcurrency) {
                        await sleep(100);
                        continue;
                    }

                    // AUDIT FIX #8: Burst limiting check
                    if (this.requestsInBurst >= this.burstLimit) {
                        const timeSinceBurst = Date.now() - this.lastBurstReset;
                        if (timeSinceBurst < this.burstCooldownMs) {
                            const waitTime = this.burstCooldownMs - timeSinceBurst;
                            logger.info(`[QUEUE] Burst limit reached, cooling down for ${Math.round(waitTime / 1000)}s`);
                            await sleep(waitTime);
                        }
                        // Reset burst counter
                        this.requestsInBurst = 0;
                        this.lastBurstReset = Date.now();
                    }

                    // Get next job
                    const job = this.queue.shift();

                    if (!job) {
                        // Queue empty
                        if (this.activeJobs.size === 0) {
                            // Don't set isProcessing = false here, let the loop continue or exit naturally
                            // this.isProcessing = false; <--- REMOVED
                            logger.info('[QUEUE] Empty, all jobs completed');

                            if (this.onQueueEmpty) {
                                this.onQueueEmpty();
                            }

                            // Break the loop if empty to allow clean exit and restart via add()
                            // But wait a bit to see if more jobs come in (debounce)
                            await sleep(100);
                            if (this.queue.length === 0) {
                                break;
                            }
                        } else {
                            await sleep(100);
                        }
                        continue;
                    }

                    // PHASE 3 FIX #30: Check domain retry budget
                    if (job.domain && !this._checkDomainRetryBudget(job.domain)) {
                        // Domain has exceeded retry budget, mark as failed
                        this.stats.processed++;
                        this.stats.failed++;
                        this.failedJobs.push({
                            ...job,
                            error: `Domain retry budget exceeded (${this.maxRetryPerDomain} failures per hour)`,
                            failedAt: Date.now(),
                            reason: 'domain_rate_limited'
                        });
                        this._enforceFailedJobsCap();
                        logger.warn(`[QUEUE] Domain ${job.domain} exceeded retry budget, skipping job ${job.id}`);
                        continue;
                    }

                    // Check domain rate limit
                    if (job.domain && !this._acquireDomainToken(job.domain)) {
                        // Rate limited for this domain, push back into queue
                        this.queue.push(job);
                        // M4-FLAW1 FIX: Re-sort by priority so high-priority jobs stay ahead
                        this.queue.sort((a, b) => b.priority - a.priority);
                        await sleep(50); // Small delay to prevent tight loop if all jobs are limited
                        continue;
                    }

                    // Increment burst counter
                    this.requestsInBurst++;

                    // FIX: Track job in activeJobs SYNCHRONOUSLY before async execution
                    // This prevents race condition where queue reports empty before job starts
                    // JQ-01: store the job OBJECT (keyed by id) so saveQueue() can serialize it.
                    this.activeJobs.set(job.id, job);

                    // B6-1: Persist active job to chrome.storage.session so it survives
                    // SW eviction. Fire-and-forget (non-blocking); _executeJob proceeds.
                    this._persistActiveJob(job);

                    // Execute job (async, runs in background)
                    this._executeJob(job);

                    // AUDIT FIX #8: Gaussian delay for natural timing
                    const delay = this._getGaussianDelay();
                    logger.debug(`[QUEUE] Waiting ${Math.round(delay)}ms before next job (Gaussian jitter)`);
                    await sleep(delay);
                }
            } catch (error) {
                logger.error('[QUEUE] Processing error:', error);
            } finally {
                this.isProcessing = false;

                // M4-BUG1 FIX: Check dirty flag OR queue length to decide re-trigger.
                // The _jobsAddedDuringProcessing flag catches jobs added while the
                // mutex was held (TOCTOU race), even if the while loop had already
                // decided to exit before the job was pushed to the queue.
                const needsRetrigger = this._jobsAddedDuringProcessing ||
                    (this.queue.length > 0 && !this.isPaused && !this.circuitOpen);

                // Reset the flag before re-triggering to avoid infinite loops
                this._jobsAddedDuringProcessing = false;

                if (needsRetrigger && !this.isPaused && !this.circuitOpen) {
                    // Use a minimal timeout to allow stack to clear and mutex to release
                    setTimeout(() => {
                        if (!this.isProcessing && this.queue.length > 0) {
                            this._processQueue();
                        }
                    }, 0);
                }
            }
        });
    }

    /**
     * Execute individual job
     */
    async _executeJob(job) {
        // NOTE: job.id already added to activeJobs synchronously before this call

        try {
            // DEFENSIVE FIX: Skip jobs with invalid functions (can happen from deserialization)
            if (typeof job.fn !== 'function') {
                logger.warn(`[JobQueue] Skipping job ${job.id} - function not valid (got ${typeof job.fn}). Removing from queue.`);
                this.activeJobs.delete(job.id);
                // B6-1: also remove from active-jobs storage
                this._unpersistActiveJob(job.id);
                // Don't retry - just remove silently
                return;
            }

            // CRAWLEE FEATURE 1.3: Respect same-domain delay
            if (job.domain) {
                await this._respectSameDomainDelay(job.domain);
            }

            logger.debug(`Executing job ${job.id} (attempt ${job.retries + 1}/${job.maxRetries + 1})`);

            const result = await job.fn();

            // Success
            this.stats.processed++;
            this.stats.succeeded++;
            this.consecutiveFailures = 0;
            this._schedulePersistCircuit();  // BG-7: persist reset

            logger.debug(`Job ${job.id} completed successfully`);

            // PHASE 2: Record success for AutoScaler adaptive concurrency
            this.autoScaler.recordResult(true, { domain: job.domain });

            if (this.onJobComplete) {
                this.onJobComplete(job, result);
            }

        } catch (error) {
            // PHASE 4 FIX #39: Use standardized error serialization
            const serialized = serializeError(error);
            const errorMessage = serialized.message;
            const errorStack = serialized.stack || 'No stack trace';

            logger.warn(`Job ${job.id} failed:`, errorMessage);

            // Retry logic
            if (job.retries < job.maxRetries) {
                job.retries++;
                this.stats.retried++;

                // CRAWLEE FEATURE 1.5: Enhanced exponential backoff with jitter
                const backoffDelay = this.calculateBackoff(job.retries - 1);

                logger.info(`[Retry] 🔄 Job ${job.id.slice(0, 12)}... retry ${job.retries}/${job.maxRetries} in ${backoffDelay}ms`);

                // Re-add to queue after delay
                // BUG-009 FIX: Add additional guards to prevent race condition
                // BGW-H2 FIX: Track timer for cleanup on stop()
                const retryJobId = job.id;
                const retryTimerId = setTimeout(() => {
                    this._untrackTimer(retryTimerId);
                    // Verify job wasn't already processed or queue cleared
                    if (this.queue.some(j => j.id === retryJobId)) {
                        logger.debug(`[QUEUE] Job ${retryJobId} already in queue, skipping re-add`);
                        return;
                    }

                    this.queue.unshift(job); // Add to front of queue

                    // Ensure queue is running to process the retry
                    // BUG-009 FIX: Use setTimeout(0) to avoid immediate re-entry
                    if (!this.isProcessing && !this.isPaused) {
                        setTimeout(() => this.start(), 0);
                    }
                }, backoffDelay);
                this._trackTimer(retryTimerId);

            } else {
                // Max retries reached
                this.stats.processed++;
                this.stats.failed++;
                this.consecutiveFailures++;

                // PHASE 3 FIX #30: Track domain retry budget
                if (job.domain) {
                    this._incrementDomainRetryBudget(job.domain);
                }

                this.failedJobs.push({
                    ...job,
                    error: errorMessage,
                    failedAt: Date.now()
                });
                this._enforceFailedJobsCap();

                logger.error(`Job ${job.id} failed permanently after ${job.retries + 1} attempts`);

                // Check circuit breaker
                if (this.consecutiveFailures >= CONFIG.errors.circuitBreakerThreshold) {
                    logger.error('Circuit breaker opened due to consecutive failures');
                    this.circuitOpen = true;
                    this.circuitOpenTime = Date.now();
                }
                // BG-7: persist after every failure increment AND after the
                // trip-check above so the open / openTime survives eviction.
                this._schedulePersistCircuit();

                // PHASE 2: Record failure for AutoScaler adaptive concurrency
                this.autoScaler.recordResult(false, { domain: job.domain, error: errorMessage });

                if (this.onJobFailed) {
                    this.onJobFailed(job, { message: errorMessage, stack: errorStack });
                }
            }
        } finally {
            this.activeJobs.delete(job.id);
            // B6-1: also remove from active-jobs storage so it isn't re-queued
            // as orphaned on next loadQueue (post-eviction).
            this._unpersistActiveJob(job.id);

            // PHASE 2 FIX: Trigger AutoScaler evaluation after each job
            // IMPROVEMENT: Pass system status for system-aware scaling
            const systemStatus = getSystemMonitor().getStatus();
            this.autoScaler.evaluate(systemStatus);

            // H-3 FIX: Check if this was the LAST job and queue is empty
            // The main loop may have exited before this job completed,
            // so we need to trigger onQueueEmpty callback here
            if (this.queue.length === 0 && this.activeJobs.size === 0 && !this.isProcessing) {
                logger.info('[QUEUE] Last job completed, triggering queue empty callback');
                if (this.onQueueEmpty) {
                    this.onQueueEmpty();
                }
            }
        }
    }

    /**
     * PHASE 3 FIX #30: Check domain retry budget
     * Prevents hammering domains that consistently fail
     * @param {string} domain - Domain to check
     * @returns {boolean} - True if budget available, false if exceeded
     */
    _checkDomainRetryBudget(domain) {
        const now = Date.now();
        const budget = this.domainRetryBudgets.get(domain);

        if (!budget) {
            return true; // No budget tracking yet, allow
        }

        // Check if budget window has expired
        if (now >= budget.resetAt) {
            // Reset expired budget
            this.domainRetryBudgets.delete(domain);
            return true;
        }

        // Check if budget exceeded
        if (budget.count >= this.maxRetryPerDomain) {
            logger.warn(`[DOMAIN BUDGET] ${domain} has ${budget.count} failures, budget exceeded`);
            return false;
        }

        return true;
    }

    /**
     * PHASE 3 FIX #30: Increment domain retry budget
     * @param {string} domain - Domain that failed
     */
    _incrementDomainRetryBudget(domain) {
        const now = Date.now();
        const budget = this.domainRetryBudgets.get(domain);

        if (!budget) {
            this.domainRetryBudgets.set(domain, {
                count: 1,
                resetAt: now + this.retryBudgetWindowMs
            });
            logger.debug(`[DOMAIN BUDGET] ${domain} budget started: 1 / ${this.maxRetryPerDomain} `);
        } else {
            budget.count++;
            logger.debug(`[DOMAIN BUDGET] ${domain} budget: ${budget.count}/${this.maxRetryPerDomain}`);
        }

        // Cleanup expired budgets to prevent memory leak
        this._cleanupExpiredBudgets();
    }

    /**
     * PHASE 3 FIX #30: Cleanup expired domain budgets
     */
    _cleanupExpiredBudgets() {
        const now = Date.now();
        for (const [domain, budget] of this.domainRetryBudgets.entries()) {
            if (now >= budget.resetAt) {
                this.domainRetryBudgets.delete(domain);
                logger.debug(`[DOMAIN BUDGET] ${domain} budget expired and cleared`);
            }
        }
    }

    /**
     * Acquire token for domain
     */
    _acquireDomainToken(domain) {
        if (!this.domainTokens.has(domain)) {
            this.domainTokens.set(domain, {
                tokens: this.domainRateLimit,
                lastRefill: Date.now()
            });
        }

        const bucket = this.domainTokens.get(domain);
        const now = Date.now();

        // Refill
        const timePassed = now - bucket.lastRefill;
        const tokensToAdd = (timePassed / 60000) * this.domainRateLimit;
        bucket.tokens = Math.min(this.domainRateLimit, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;

        if (bucket.tokens >= 1) {
            bucket.tokens--;
            return true;
        }

        return false;
    }

    /**
     * M4-MISS1: Enforce maximum size cap on failedJobs array
     * Prunes oldest entries when cap is exceeded
     */
    _enforceFailedJobsCap() {
        if (this.failedJobs.length > JobQueue.MAX_FAILED_JOBS) {
            const excess = this.failedJobs.length - JobQueue.MAX_FAILED_JOBS;
            this.failedJobs.splice(0, excess);
            logger.debug(`[QUEUE] Pruned ${excess} oldest failed jobs (cap: ${JobQueue.MAX_FAILED_JOBS})`);
        }
    }

    /**
     * M4-MISS2: Clean up stale domainTokens entries
     * Removes entries not accessed for over 1 hour to prevent unbounded Map growth
     */
    cleanupStaleDomainTokens() {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [domain, bucket] of this.domainTokens.entries()) {
            if (now - bucket.lastRefill > JobQueue.DOMAIN_TOKEN_STALE_MS) {
                this.domainTokens.delete(domain);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            logger.debug(`[QUEUE] Cleaned up ${cleanedCount} stale domain token entries`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 1.3: Same Domain Delay
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Respect minimum delay between requests to the same domain
     * @param {string} domain - Target domain
     * @returns {Promise<void>}
     */
    async _respectSameDomainDelay(domain) {
        if (!domain || this.testMode) return;

        const lastRequest = this.lastDomainRequest.get(domain);
        if (lastRequest) {
            const elapsed = Date.now() - lastRequest;
            if (elapsed < this.sameDomainDelayMs) {
                const waitTime = this.sameDomainDelayMs - elapsed;
                logger.info(`[SameDomainDelay] ⏱️ Waiting ${waitTime}ms for ${domain}`);
                await sleep(waitTime);
            }
        }

        this.lastDomainRequest.set(domain, Date.now());

        // Clean up old entries (older than 1 minute)
        if (this.lastDomainRequest.size > 100) {
            const cutoff = Date.now() - 60000;
            for (const [d, t] of this.lastDomainRequest) {
                if (t < cutoff) {
                    this.lastDomainRequest.delete(d);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 1.5: Exponential Backoff with Jitter
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Calculate backoff delay with exponential growth and jitter
     * Formula: delay = min(baseDelay * 2^retryCount, maxDelay) ± jitter
     * @param {number} retryCount - Current retry attempt (0-based)
     * @returns {number} Delay in milliseconds
     */
    calculateBackoff(retryCount) {
        if (this.testMode) return 10;

        // Exponential growth: 1s, 2s, 4s, 8s, 16s...
        const exponential = Math.min(
            this.backoffBase * Math.pow(2, retryCount),
            this.backoffMax
        );

        // Add jitter: ±25% randomness to prevent thundering herd
        const jitterRange = exponential * this.backoffJitterPercent;
        const jitter = (Math.random() * 2 - 1) * jitterRange;

        // P2-011 FIX: Ensure delay is never negative or too small
        const finalDelay = Math.max(100, Math.round(exponential + jitter));

        logger.info(`[Backoff] 🔄 Retry ${retryCount + 1}: ${finalDelay}ms (base: ${exponential}ms, jitter: ${jitter > 0 ? '+' : ''}${Math.round(jitter)}ms)`);

        return finalDelay;
    }

    /**
     * Log backoff statistics
     */
    logBackoffStats() {
        const delays = [];
        for (let i = 0; i < 5; i++) {
            delays.push(`R${i + 1}: ${Math.round(this.backoffBase * Math.pow(2, i))}ms`);
        }
        logger.info(`[Backoff] 📊 Exponential delays: ${delays.join(' → ')} (max: ${this.backoffMax}ms, jitter: ±${this.backoffJitterPercent * 100}%)`);
    }

    /**
     * Generate unique job ID
     * BUG #22 FIX: Replace deprecated substr() with substring()
     */
    _generateJobId() {
        return `job_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    /**
     * Get failed jobs
     */
    getFailedJobs() {
        return [...this.failedJobs];
    }

    /**
     * Retry all failed jobs
     */
    retryFailedJobs() {
        const failed = [...this.failedJobs];
        this.failedJobs = [];

        failed.forEach(job => {
            job.retries = 0; // Reset retry count
            this.queue.push(job);
        });

        logger.info(`Re-queued ${failed.length} failed jobs`);

        if (!this.isProcessing) {
            this.start();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 3.3: Queue Persistence
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Storage key for queue persistence
     * @private
     */
    _persistKey = 'ghost_map_job_queue';

    /**
     * Storage key for active-job tracking (B6-1 P0 fix).
     * Separate from _persistKey because active jobs need different lifecycle:
     * written on dispatch, removed on completion, scanned on init for orphans.
     * @private
     */
    _activeJobsPersistKey = 'ghost_map_job_queue.active_jobs';

    /**
     * Schema version for the active-jobs persisted payload (B6-1 NSA hardening).
     * Bump on incompatible schema change; mismatched payloads are discarded.
     * @private
     */
    _activeJobsSchemaVersion = 1;

    /**
     * Recovery telemetry — count of orphaned jobs recovered on the last
     * loadQueue() call. Exposed via getPersistenceStats() for observability.
     * @private
     */
    _lastRecoveredOrphanedCount = 0;

    /**
     * Job type registry for deserialization
     * Maps job types to factory functions
     * @private
     */
    _jobRegistry = new Map();

    /**
     * Auto-save interval reference
     * @private
     */
    _autoSaveInterval = null;

    /**
     * Register a job type for persistence
     * This allows jobs to be serialized and later reconstructed
     * @param {string} type - Job type identifier
     * @param {Function} factory - Factory function that creates job function from params
     * @example
     * queue.registerJobType('email_scrape', (params) => () => scrapeEmail(params.businessId));
     */
    registerJobType(type, factory) {
        this._jobRegistry.set(type, factory);
        logger.debug(`[JobQueue] Registered job type: ${type}`);
    }

    /**
     * Add a typed job that can be persisted
     * @param {string} type - Job type (must be registered)
     * @param {Object} params - Parameters to pass to job factory
     * @param {Object} options - Standard job options (priority, maxRetries, etc.)
     * @returns {string} Job ID
     */
    addTypedJob(type, params, options = {}) {
        const factory = this._jobRegistry.get(type);
        if (!factory) {
            throw new Error(`Unknown job type: ${type}. Register it first with registerJobType()`);
        }

        const job = {
            id: this._generateJobId(),
            fn: factory(params),
            type, // Store type for persistence
            params, // Store params for persistence
            priority: options.priority || 0,
            retries: 0,
            maxRetries: options.maxRetries || CONFIG.errors.maxRetries,
            addedAt: Date.now(),
            domain: options.domain || null,
            persistable: true
        };

        // Extract domain from params if available
        if (params.url && !job.domain) {
            try {
                let urlStr = params.url;
                if (!urlStr.startsWith('http')) {
                    urlStr = 'https://' + urlStr;
                }
                job.domain = new URL(urlStr).hostname;
            } catch (e) {
                // Ignore URL parsing errors
            }
        }

        this.queue.push(job);
        this.queue.sort((a, b) => b.priority - a.priority);

        logger.debug(`[JobQueue] Typed job ${job.id} added (type: ${type})`);

        if (!this.isProcessing && !this.isPaused) {
            this.start();
        }

        return job.id;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // B6-1 P0 FIX: Active-job persistence (eviction-safe)
    // ─────────────────────────────────────────────────────────────────────────
    // saveQueue() explicitly excludes activeJobs (line above is `!this.activeJobs.has(job.id)`).
    // Pre-fix consequence: an in-flight job at the moment of SW eviction is
    // SILENTLY LOST — no recovery, no retry, no metric. For email scraping
    // with maxConcurrent=5, every eviction wipes up to 5 emails.
    //
    // Fix: persist each active typed job to chrome.storage.session at dispatch
    // time, remove on completion, and re-enqueue any orphaned entries on next
    // loadQueue() call (with retry counter incremented to bound recovery loops).
    //
    // Closure jobs (added via add(jobFunction)) are NOT persistable — no `type`,
    // no factory to reconstruct. They remain a B6-2 (P1) concern — see audit.
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Persist a job to the active-jobs storage entry. Called immediately after
     * activeJobs.add() so the job survives SW eviction.
     *
     * Only typed/persistable jobs are stored — closure-only jobs cannot be
     * reconstructed from storage and are silently skipped.
     *
     * Storage entry shape (schema v1):
     *   {
     *     version: 1,
     *     entries: {
     *       <jobId>: { id, type, params, retries, maxRetries, addedAt, domain, startedAt, persistable: true }
     *     }
     *   }
     *
     * @private
     * @param {Object} job
     */
    async _persistActiveJob(job) {
        if (!job?.persistable || !job?.type) return;  // closure jobs: skip
        try {
            const r = await chrome.storage.session.get(this._activeJobsPersistKey);
            const cur = r[this._activeJobsPersistKey];
            const entries = (cur && cur.version === this._activeJobsSchemaVersion && cur.entries)
                ? cur.entries
                : {};
            entries[job.id] = {
                id: job.id,
                type: job.type,
                params: job.params,
                retries: job.retries || 0,
                maxRetries: job.maxRetries || CONFIG.errors.maxRetries,
                addedAt: job.addedAt,
                domain: job.domain,
                startedAt: Date.now(),
                persistable: true
            };
            await chrome.storage.session.set({
                [this._activeJobsPersistKey]: {
                    version: this._activeJobsSchemaVersion,
                    entries
                }
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug('[JobQueue] _persistActiveJob failed:', msg);
        }
    }

    /**
     * Remove a job from the active-jobs storage entry. Called from the
     * activeJobs.delete() sites (success path, early-exit, finally block).
     *
     * @private
     * @param {string} jobId
     */
    async _unpersistActiveJob(jobId) {
        if (!jobId) return;
        try {
            const r = await chrome.storage.session.get(this._activeJobsPersistKey);
            const cur = r[this._activeJobsPersistKey];
            if (!cur || cur.version !== this._activeJobsSchemaVersion || !cur.entries) return;
            if (!(jobId in cur.entries)) return;
            delete cur.entries[jobId];
            await chrome.storage.session.set({
                [this._activeJobsPersistKey]: cur
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.debug('[JobQueue] _unpersistActiveJob failed:', msg);
        }
    }

    /**
     * Recover active jobs that were in-flight at the moment of SW eviction.
     * Called from loadQueue() after the regular queue restore.
     *
     * Strategy:
     *   - Read active-jobs storage entry. Drop on schema mismatch (NSA).
     *   - Filter by maxAge (1h): jobs older than that are stale, drop them.
     *   - Type-validate each entry; reject malformed payloads.
     *   - Re-enqueue each surviving job with retries incremented (bounds
     *     infinite recovery loops; respects per-job maxRetries).
     *   - Wipe the active-jobs storage entry after recovery.
     *
     * @private
     * @returns {Promise<number>} Number of jobs recovered
     */
    async _recoverOrphanedActiveJobs() {
        try {
            const r = await chrome.storage.session.get(this._activeJobsPersistKey);
            const cur = r[this._activeJobsPersistKey];
            if (!cur || typeof cur !== 'object') {
                this._lastRecoveredOrphanedCount = 0;
                return 0;
            }
            // Schema check
            if (cur.version !== this._activeJobsSchemaVersion || !cur.entries) {
                logger.warn(
                    `[JobQueue] active-jobs schema mismatch (got v${cur.version}, ` +
                    `expected v${this._activeJobsSchemaVersion}). Discarding.`
                );
                await chrome.storage.session.remove(this._activeJobsPersistKey);
                this._lastRecoveredOrphanedCount = 0;
                return 0;
            }

            const maxAge = 60 * 60 * 1000;  // 1h, same as queue persistence
            const now = Date.now();
            let recovered = 0;
            let dropped = 0;

            for (const jobData of Object.values(cur.entries)) {
                // Type validation (NSA hardening)
                if (!jobData || typeof jobData !== 'object') { dropped++; continue; }
                const j = /** @type {any} */ (jobData);
                if (typeof j.id !== 'string' || typeof j.type !== 'string') { dropped++; continue; }
                if (typeof j.startedAt !== 'number' || !Number.isFinite(j.startedAt)) { dropped++; continue; }

                // Age check
                if (now - j.startedAt > maxAge) {
                    logger.debug(`[JobQueue] orphaned job ${j.id} too old (${Math.round((now - j.startedAt) / 60000)}min), dropping`);
                    dropped++;
                    continue;
                }

                // Factory check
                const factory = this._jobRegistry.get(j.type);
                if (!factory) {
                    logger.warn(`[JobQueue] orphaned job ${j.id}: unknown type "${j.type}", dropping`);
                    dropped++;
                    continue;
                }

                // Retry budget — orphaned jobs are partial-execution; bump retries
                // to bound recovery loops. If already at max, drop.
                const newRetries = (j.retries || 0) + 1;
                if (newRetries > (j.maxRetries || CONFIG.errors.maxRetries)) {
                    logger.warn(`[JobQueue] orphaned job ${j.id}: retry budget exhausted, dropping`);
                    dropped++;
                    continue;
                }

                // Re-enqueue. Avoid duplicate if loadQueue already restored it.
                const existing = this.queue.find(qj => qj.id === j.id);
                if (existing) { dropped++; continue; }

                const reconstructed = {
                    id: j.id,
                    type: j.type,
                    params: j.params,
                    fn: factory(j.params),
                    priority: 10,  // High priority — recovery first
                    retries: newRetries,
                    maxRetries: j.maxRetries || CONFIG.errors.maxRetries,
                    addedAt: j.addedAt || Date.now(),
                    domain: j.domain || null,
                    persistable: true
                };
                this.queue.push(reconstructed);
                recovered++;
            }

            if (recovered > 0 || dropped > 0) {
                logger.info(
                    `[JobQueue] 🔄 Active-job recovery: ${recovered} re-enqueued, ${dropped} dropped ` +
                    `(stale/invalid/exhausted-retry)`
                );
                // Sort by priority — recovered jobs (priority=10) go to front
                this.queue.sort((a, b) => b.priority - a.priority);
            }

            // Wipe storage entry: recovered jobs now live in queue and will be
            // re-persisted via _persistActiveJob when they execute.
            await chrome.storage.session.remove(this._activeJobsPersistKey);

            this._lastRecoveredOrphanedCount = recovered;
            return recovered;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn('[JobQueue] _recoverOrphanedActiveJobs failed:', msg);
            this._lastRecoveredOrphanedCount = 0;
            return 0;
        }
    }

    /**
     * Save queue state to chrome.storage
     * Only saves persistable (typed) jobs
     * @returns {Promise<number>} Number of jobs saved
     */
    async saveQueue() {
        try {
            // 2026-05-15 FIX: persist active jobs too, not just pending.
            //
            // Pre-fix: only `this.queue` was saved. But the run loop
            // shifts a job OUT of this.queue and INTO this.activeJobs
            // the moment it starts executing (line ~562). So any job
            // currently in-flight was invisible to saveQueue(). If
            // Chrome evicted the SW with N workers active (typical:
            // 3–5 concurrent), all N jobs died with the SW and were
            // LOST from persistence — restore on next boot found
            // 0 jobs and the operator saw "stuck at 38%" forever.
            //
            // Observed today: 40-business scrape stuck at 15/40 after
            // SW eviction with ~25 active jobs in flight.
            //
            // Fix: serialize union(activeJobs, queue). Active jobs
            // get retries+1 on restore — they were mid-attempt when
            // killed, so we conservatively count the dead attempt
            // (prevents infinite loops on jobs that hard-crash the
            // SW; trade-off: a job that died at the start of an
            // attempt loses one retry budget). Dedup by id, active
            // wins (already has the +1).
            //
            // MAX_PERSIST_JOBS bound prevents an unbounded queue
            // from blowing the chrome.storage.local 10 MB quota
            // (e.g. operator queues 10k businesses by mistake).
            const MAX_PERSIST_JOBS = 500;

            const activeJobsArr = Array.from(this.activeJobs.values())
                .filter(job => job.persistable && job.type)
                .map(job => ({ ...job, retries: (job.retries || 0) + 1 }));

            const pendingJobs = this.queue.filter(job =>
                job.persistable && job.type
            );

            // Dedup: any pending job with same id as an active job is
            // dropped from pending (shouldn't happen in practice but
            // defensive against future code paths re-queuing during
            // execution).
            const activeIds = new Set(activeJobsArr.map(j => j.id));
            const combined = [
                ...activeJobsArr,
                ...pendingJobs.filter(j => !activeIds.has(j.id))
            ];

            let toSave = combined;
            if (combined.length > MAX_PERSIST_JOBS) {
                logger.warn(
                    `[JobQueue] Persist truncated: ${combined.length} > ${MAX_PERSIST_JOBS} ` +
                    `(active=${activeJobsArr.length}, pending=${pendingJobs.length}). ` +
                    `Older pending jobs dropped — increase MAX_PERSIST_JOBS if intentional.`
                );
                toSave = combined.slice(0, MAX_PERSIST_JOBS);
            }

            const serialized = {
                version: 1,
                timestamp: Date.now(),
                stats: { ...this.stats },
                jobs: toSave.map(job => ({
                    id: job.id,
                    type: job.type,
                    params: job.params,
                    priority: job.priority,
                    retries: job.retries,
                    maxRetries: job.maxRetries,
                    addedAt: job.addedAt,
                    domain: job.domain
                }))
            };

            await chrome.storage.local.set({ [this._persistKey]: serialized });

            if (toSave.length > 0) {
                logger.debug(
                    `[JobQueue] 💾 Saved ${toSave.length} jobs to storage ` +
                    `(${activeJobsArr.length} active + ${pendingJobs.length} pending)`
                );
            }

            return toSave.length;
        } catch (error) {
            logger.warn(`[JobQueue] Save failed: ${error.message}`);
            return 0;
        }
    }

    /**
     * Load queue state from chrome.storage
     * @returns {Promise<number>} Number of jobs loaded
     */
    async loadQueue() {
        try {
            const result = await chrome.storage.local.get(this._persistKey);
            const saved = result[this._persistKey];

            if (!saved || saved.version !== 1) {
                logger.debug('[JobQueue] No saved queue found or version mismatch');
                return 0;
            }

            // Filter out jobs that are too old (> 24 hours)
            const maxAge = 24 * 60 * 60 * 1000;
            const now = Date.now();
            const validJobs = saved.jobs.filter(job =>
                now - job.addedAt < maxAge
            );

            let loaded = 0;

            for (const jobData of validJobs) {
                const factory = this._jobRegistry.get(jobData.type);
                if (!factory) {
                    logger.warn(`[JobQueue] Skipping unknown job type: ${jobData.type}`);
                    continue;
                }

                // Reconstruct the job
                const job = {
                    ...jobData,
                    fn: factory(jobData.params),
                    persistable: true
                };

                // Add to queue (avoiding duplicates)
                const existing = this.queue.find(j => j.id === job.id);
                if (!existing) {
                    this.queue.push(job);
                    loaded++;
                }
            }

            // Sort by priority
            if (loaded > 0) {
                this.queue.sort((a, b) => b.priority - a.priority);
            }

            // Restore stats
            if (saved.stats) {
                this.stats = { ...this.stats, ...saved.stats };
            }

            if (loaded > 0) {
                logger.info(`[JobQueue] 📂 Loaded ${loaded} jobs from storage (${validJobs.length - loaded} skipped)`);
            }

            // B6-1: After regular queue restore, recover any active jobs that
            // were in-flight at the moment of SW eviction. Adds to `loaded` count.
            const recovered = await this._recoverOrphanedActiveJobs();

            return loaded + recovered;
        } catch (error) {
            logger.warn(`[JobQueue] Load failed: ${error.message}`);
            return 0;
        }
    }

    /**
     * Clear saved queue from storage
     * @returns {Promise<void>}
     */
    async clearSavedQueue() {
        try {
            await chrome.storage.local.remove(this._persistKey);
            logger.debug('[JobQueue] Cleared saved queue');
        } catch (error) {
            logger.warn(`[JobQueue] Clear saved queue failed: ${error.message}`);
        }
    }

    /**
     * H-2 FIX: Initialize method for JobQueue persistence
     * Called from background/index.js during startup
     * @param {Object} options - Initialization options
     * @param {number} options.autoSaveIntervalMs - Auto-save interval (default: 30000)
     * @param {boolean} options.loadFromStorage - Whether to load saved queue (default: true)
     * @returns {Promise<number>} Number of jobs restored from storage
     */
    async initialize(options = {}) {
        const {
            autoSaveIntervalMs = 30000,
            loadFromStorage = true
        } = options;

        let restoredCount = 0;

        // Load saved queue if requested
        if (loadFromStorage) {
            restoredCount = await this.loadQueue();
            if (restoredCount > 0) {
                logger.info(`[JobQueue] 🔄 Restored ${restoredCount} jobs from previous session`);
            }
        }

        // Start auto-save
        if (autoSaveIntervalMs > 0) {
            this.startAutoSave(autoSaveIntervalMs);
        }

        logger.info('[JobQueue] ✅ Initialization complete');
        return restoredCount;
    }

    /**
     * Start auto-saving queue at regular intervals
     * @param {number} intervalMs - Save interval in milliseconds (default: 30s)
     */
    startAutoSave(intervalMs = 30000) {
        // Stop any existing interval
        this.stopAutoSave();

        this._autoSaveInterval = setInterval(async () => {
            if (this.queue.length > 0) {
                await this.saveQueue();
            }
        }, intervalMs);

        // Also save immediately
        this.saveQueue().catch(() => { });

        logger.info(`[JobQueue] ⏱️ Auto-save started (every ${intervalMs / 1000}s)`);
    }

    /**
     * Stop auto-saving
     */
    stopAutoSave() {
        if (this._autoSaveInterval) {
            clearInterval(this._autoSaveInterval);
            this._autoSaveInterval = null;
            logger.debug('[JobQueue] Auto-save stopped');
        }
    }

    /**
     * Shutdown queue gracefully
     * BGW-H2 FIX: Clears pending timers, saves state, and stops auto-save
     * @returns {Promise<void>}
     */
    async shutdown() {
        // M4-MISS3 FIX: Stop active job processing first
        await this.stop();

        // BGW-H2 FIX: Clear pending timers first
        this._clearPendingTimers();

        // M4-MISS2: Clear domainTokens cleanup interval
        if (this._domainTokenCleanupInterval) {
            clearInterval(this._domainTokenCleanupInterval);
            this._domainTokenCleanupInterval = null;
        }

        // Stop auto-save
        this.stopAutoSave();

        // Final save
        const saved = await this.saveQueue();

        logger.info(`[JobQueue] 💾 Shutdown complete (saved: ${saved} jobs)`);
    }

    /**
     * Get persistence statistics
     * @returns {Object}
     */
    getPersistenceStats() {
        const persistableCount = this.queue.filter(j => j.persistable).length;
        return {
            totalJobs: this.queue.length,
            persistableJobs: persistableCount,
            registeredTypes: Array.from(this._jobRegistry.keys()),
            autoSaveEnabled: !!this._autoSaveInterval,
            // B6-1: telemetry — count of orphaned jobs recovered on last loadQueue.
            // Useful for monitoring SW eviction frequency × active-job impact.
            lastRecoveredOrphanedCount: this._lastRecoveredOrphanedCount
        };
    }
}

export default JobQueue;

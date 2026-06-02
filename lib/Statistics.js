/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee Statistics
 * https://crawlee.dev/js/api/core/class/Statistics
 */

/**
 * Ghost Map Pro - Crawler Statistics
 * Comprehensive metrics collection for monitoring and debugging
 * 
 * Key metrics from Crawlee:
 * - Request counts (total, finished, failed, retried)
 * - Duration tracking with rolling averages
 * - Success rates per domain
 * - Resource monitoring
 */

import { logger } from './utils.js';

// Late-bound reference to SessionPool (set via setSessionPool to avoid circular import)
let _sessionPoolRef = null;

/**
 * Register SessionPool reference for statistics integration
 * @param {Object} sessionPool - SessionPool instance
 */
export function setSessionPoolForStats(sessionPool) {
    _sessionPoolRef = sessionPool;
    logger.debug('[Statistics] SessionPool reference registered');
}

/**
 * CrawlerStatistics Class
 * Tracks all metrics for the email scraping process.
 *
 * ─── MV3 SW EVICTION POLICY (B11-6 #4 re-evaluated 2026-05-10) ──────────────
 *
 * The original ultrareview B11-6 cluster triage flagged this class as HOT
 * (5 K request-durations + 200+ domain stats + retry/error histograms lost
 * on SW eviction → "operator sees job restarted from 0"). Re-evaluation:
 *
 *   • The class previously had persist()/restore() methods. They were
 *     EXPLICITLY removed in commit M8-BUG6 (see lines 847-849) because
 *     `restore() was a no-op (read data but never applied it)` and
 *     `persist() wrote data that was never meaningfully consumed`.
 *
 *   • The "operator sees reset → may retrigger thinking it failed → duplicate
 *     processing" damaging scenario in the triage is weak: the JobQueue has
 *     its own persistence (B6-1), saveBusiness is idempotent via
 *     googleMapsUrl primary key, and operator retrigger does NOT cause
 *     duplicates — at worst it causes a no-op re-extraction.
 *
 *   • Telemetry loss IS observable (dashboard counters reset to 0) but is
 *     not a data path. The state is reconstructed by re-running the workload.
 *
 * Decision: classify as SAFE-BY-SEMANTICS (downgraded from HOT in §11.5
 * triage). Telemetry is ephemeral by deliberate design choice — the
 * M8-BUG6 commit removed the persistence as an anti-pattern. Reintroducing
 * it would resurrect the same problem.
 *
 * SW-EVICTION-SAFE: telemetry ephemeral by design (M8-BUG6 verdict).
 */
export class CrawlerStatistics {
    /**
     * Create a new CrawlerStatistics instance
     * @param {Object} options - Configuration options
     * @param {number} [options.logIntervalSecs=60] - Interval for auto-logging (0 to disable)
     */
    constructor(options = {}) {
        this.options = {
            logIntervalSecs: options.logIntervalSecs ?? 60,
            ...options
        };

        this.reset();
        this.logInterval = null;
    }

    /**
     * Reset all statistics to initial state
     */
    reset() {
        this.startTime = Date.now();

        this.stats = {
            // ─────────────────────────────────────────────────────────────
            // Request metrics
            // ─────────────────────────────────────────────────────────────
            requestsTotal: 0,
            requestsFinished: 0,
            requestsFailed: 0,
            requestsRetried: 0,
            requestsSkipped: 0,

            // ─────────────────────────────────────────────────────────────
            // Email scraping specific
            // ─────────────────────────────────────────────────────────────
            emailsFound: 0,
            emailsValidated: 0,
            websitesExtracted: 0,
            businessesProcessed: 0,
            businessesWithEmail: 0,

            // ─────────────────────────────────────────────────────────────
            // Timing (rolling window of last 100)
            // ─────────────────────────────────────────────────────────────
            requestDurations: [],
            avgRequestDuration: 0,
            minRequestDuration: Infinity,
            maxRequestDuration: 0,

            // ─────────────────────────────────────────────────────────────
            // Data transfer
            // ─────────────────────────────────────────────────────────────
            bytesDownloaded: 0,
            pagesDownloaded: 0,

            // ─────────────────────────────────────────────────────────────
            // Errors by type
            // ─────────────────────────────────────────────────────────────
            errorsByType: new Map(),

            // ─────────────────────────────────────────────────────────────
            // Domain-specific stats
            // ─────────────────────────────────────────────────────────────
            domainStats: new Map(),

            // ─────────────────────────────────────────────────────────────
            // Session stats
            // ─────────────────────────────────────────────────────────────
            sessionsCreated: 0,
            sessionsRetired: 0,

            // ─────────────────────────────────────────────────────────────
            // Rate limiting & blocking
            // ─────────────────────────────────────────────────────────────
            rateLimitHits: 0,
            cloudflareBlocks: 0,
            timeouts: 0,

            // ─────────────────────────────────────────────────────────────
            // Memory (if available)
            // ─────────────────────────────────────────────────────────────
            peakMemoryUsage: 0,

            // ─────────────────────────────────────────────────────────────
            // CRAWLEE FEATURE 1.1: Retry Histogram
            // Tracks distribution of retries: [0 retries, 1 retry, 2 retries, ...]
            // ─────────────────────────────────────────────────────────────
            retryHistogram: new Array(6).fill(0), // Support up to 5 retries

            // ─────────────────────────────────────────────────────────────
            // CRAWLEE FEATURE 2.4: Domain Health Tracking
            // Enhanced domain stats with consecutive failures
            // ─────────────────────────────────────────────────────────────
            unhealthyDomains: new Set(),

            // ─────────────────────────────────────────────────────────────
            // R10 (TIER A): Selector strategy telemetry.
            // Tracks WHICH SelectorEngine strategy (data-attr / aria-label
            // / role / hardcoded class / text-pattern) actually produced
            // each field. Operators watch the proportion of brittle
            // class-selectors vs. semantic attribute-selectors to predict
            // selector decay BEFORE Maps changes break extraction.
            //
            // Schema:
            //   selectorHits[signature] = { hits, attempts, lastHitAt }
            //   selectorClassHitsByField[field] = number of class-only hits
            // ─────────────────────────────────────────────────────────────
            selectorHits: new Map(),
            selectorClassHitsByField: new Map(),
            selectorTotalHits: 0,
            selectorTotalAttempts: 0
        };

        logger.info('[Statistics] 📊 Reset all metrics (Crawlee features enabled)');
    }

    /**
     * Start automatic logging intervals
     * Includes guard to prevent memory leaks from multiple calls
     */
    start() {
        // MEMORY SAFETY: Prevent multiple interval creations
        if (this._isStarted) {
            logger.debug('[Statistics] Already started, skipping duplicate start');
            return;
        }
        this._isStarted = true;

        this.startTime = Date.now();
        this.logCount = 0; // CRAWLEE: Track log count for Crawlee stats interval

        // Periodic logging
        if (this.options.logIntervalSecs > 0) {
            this.logInterval = setInterval(() => {
                this.logProgress();

                // CRAWLEE: Log detailed stats every 5th log (5 minutes with default 60s interval)
                this.logCount++;
                if (this.logCount % 5 === 0) {
                    this.logCrawleeStats();
                }
            }, this.options.logIntervalSecs * 1000);
        }

        // M8-BUG6: Removed write-only persist interval (restore was a no-op)

        logger.info('[Statistics] Started tracking with Crawlee features enabled');
    }

    /**
     * Stop automatic logging
     */
    stop() {
        if (this.logInterval) {
            clearInterval(this.logInterval);
            this.logInterval = null;
        }
        // Reset started flag to allow restart
        this._isStarted = false;

        logger.info('[Statistics] Stopped tracking');
    }

    /**
     * Record a completed request
     * @param {Object} data - Request data
     * @param {number} [data.duration=0] - Request duration in ms
     * @param {boolean} [data.success=true] - Whether request succeeded
     * @param {string} [data.domain='unknown'] - Domain of request
     * @param {boolean} [data.retried=false] - Whether this was a retry
     * @param {number} [data.bytes=0] - Bytes downloaded
     * @param {number} [data.emailsFound=0] - Emails found in this request
     * @param {string|Error} [data.error=null] - Error if failed
     */
    recordRequest(data) {
        const {
            duration = 0,
            success = true,
            domain = 'unknown',
            retried = false,
            bytes = 0,
            emailsFound = 0,
            error = null
        } = data;

        this.stats.requestsTotal++;

        if (success) {
            this.stats.requestsFinished++;
        } else {
            this.stats.requestsFailed++;
        }

        if (retried) {
            this.stats.requestsRetried++;
        }

        // Duration tracking (rolling window)
        if (duration > 0) {
            this.stats.requestDurations.push(duration);

            // Keep only last 100 for rolling average
            if (this.stats.requestDurations.length > 100) {
                this.stats.requestDurations.shift();
            }

            // Update min/max/avg
            this.stats.minRequestDuration = Math.min(this.stats.minRequestDuration, duration);
            this.stats.maxRequestDuration = Math.max(this.stats.maxRequestDuration, duration);
            this.stats.avgRequestDuration = this._calculateAverage(this.stats.requestDurations);
        }

        // Bytes
        this.stats.bytesDownloaded += bytes;
        if (bytes > 0) {
            this.stats.pagesDownloaded++;
        }

        // Emails
        this.stats.emailsFound += emailsFound;

        // Error tracking
        if (error) {
            const errorType = this._categorizeError(error);
            const count = this.stats.errorsByType.get(errorType) || 0;
            this.stats.errorsByType.set(errorType, count + 1);

            // Track specific error types
            if (errorType === 'cloudflare') {
                this.stats.cloudflareBlocks++;
            } else if (errorType === 'rate_limit') {
                this.stats.rateLimitHits++;
            } else if (errorType === 'timeout') {
                this.stats.timeouts++;
            }
        }

        // Domain stats
        this._updateDomainStats(domain, success, duration, emailsFound);

        // Memory check
        this._checkMemory();
    }

    /**
     * R10: ingest a SelectorEngine telemetry snapshot. Aggregates per-strategy
     * hits across the full session.
     *
     * Call site: after each `extractAll()` (or batch of them), pass
     * `selectorEngine.getTelemetry()` here. SelectorEngine itself doesn't
     * import Statistics, to avoid a circular dependency from a leaf utility.
     *
     * @param {Array<{signature, hits, attempts, lastHitAt}>} snapshot
     * @param {Object} [options]
     * @param {boolean} [options.deltaMode=true] - if true, treats snapshot as
     *   a per-instance running counter; takes the MAX with previously-seen
     *   value. Avoids over-counting when the same engine is sampled twice.
     */
    recordSelectorTelemetry(snapshot, options = {}) {
        const deltaMode = options.deltaMode !== false;
        if (!Array.isArray(snapshot) || snapshot.length === 0) return;

        for (const entry of snapshot) {
            if (!entry || !entry.signature) continue;

            const prior = this.stats.selectorHits.get(entry.signature)
                || { hits: 0, attempts: 0, lastHitAt: null };

            // The instance counter is monotonic per-engine; we accumulate the
            // MAX so re-sampling the same engine doesn't double-count.
            const newHits = deltaMode ? Math.max(prior.hits, entry.hits) : prior.hits + entry.hits;
            const newAttempts = deltaMode
                ? Math.max(prior.attempts, entry.attempts)
                : prior.attempts + entry.attempts;
            const hitDelta = newHits - prior.hits;
            const attemptDelta = newAttempts - prior.attempts;

            this.stats.selectorHits.set(entry.signature, {
                hits: newHits,
                attempts: newAttempts,
                lastHitAt: entry.lastHitAt || prior.lastHitAt
            });

            this.stats.selectorTotalHits += hitDelta;
            this.stats.selectorTotalAttempts += attemptDelta;

            // Brittle class-selector detection. A selector is brittle when it
            // depends on a CSS class (.foo) AND does NOT carry a semantic
            // anchor like [aria-...], [role=...], [data-...] which Google is
            // unlikely to break in routine UI churn.
            //   "selector:h1.DUwDvf"          → BRITTLE (tag.class)
            //   "selector:.qBF1Pd"            → BRITTLE (pure class)
            //   "selector:[role=heading]..."  → not brittle (semantic)
            //   "selector:[aria-label]"       → not brittle (semantic)
            const m = /^([^|]+)\|selector:(.+)$/.exec(entry.signature);
            if (m && hitDelta > 0) {
                const field = m[1];
                const selector = m[2];
                const hasClass = /\.[A-Za-z0-9_-]+/.test(selector);
                const hasSemanticAnchor = /\[(?:aria-|role|data-)/i.test(selector);
                if (hasClass && !hasSemanticAnchor) {
                    this.stats.selectorClassHitsByField.set(
                        field,
                        (this.stats.selectorClassHitsByField.get(field) || 0) + hitDelta
                    );
                }
            }
        }
    }

    /**
     * R10: report-friendly view of selector decay.
     * Returns per-field breakdown of class-selector dominance (the canary
     * for Google Maps DOM changes). High class-share means brittle fallbacks
     * are bearing the load and a UI change is imminent.
     *
     * @returns {Object} { totalHits, classHits, classShare, byField }
     */
    getSelectorDecayReport() {
        const totalHits = this.stats.selectorTotalHits;
        let classHits = 0;
        const byField = {};

        for (const [field, count] of this.stats.selectorClassHitsByField.entries()) {
            classHits += count;
            byField[field] = { classHits: count };
        }

        // Compute per-field totals to derive shares
        for (const [signature, entry] of this.stats.selectorHits.entries()) {
            const field = signature.split('|')[0];
            if (!byField[field]) byField[field] = { classHits: 0 };
            byField[field].totalHits = (byField[field].totalHits || 0) + entry.hits;
        }
        for (const f of Object.keys(byField)) {
            const { classHits: c, totalHits: t } = byField[f];
            byField[f].classShare = t > 0 ? c / t : 0;
        }

        return {
            totalHits,
            classHits,
            classShare: totalHits > 0 ? classHits / totalHits : 0,
            byField
        };
    }

    /**
     * Record email found
     * @param {boolean} [validated=false] - Whether email was validated
     */
    recordEmail(validated = false) {
        this.stats.emailsFound++;
        if (validated) {
            this.stats.emailsValidated++;
        }
    }

    /**
     * Record website extraction
     */
    recordWebsiteExtracted() {
        this.stats.websitesExtracted++;
    }

    /**
     * Record business processed
     * @param {boolean} [foundEmail=false] - Whether email was found for this business
     */
    recordBusinessProcessed(foundEmail = false) {
        this.stats.businessesProcessed++;
        if (foundEmail) {
            this.stats.businessesWithEmail++;
        }
    }

    /**
     * Record session events
     * @param {string} event - 'created' or 'retired'
     */
    recordSessionEvent(event) {
        if (event === 'created') {
            this.stats.sessionsCreated++;
        } else if (event === 'retired') {
            this.stats.sessionsRetired++;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 1.1: Retry Histogram
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Record successful request with retry count for histogram
     * @param {number} retryCount - Number of retries before success (0 = first attempt)
     */
    recordRetrySuccess(retryCount) {
        const index = Math.min(retryCount, this.stats.retryHistogram.length - 1);
        if (index >= 0) {
            this.stats.retryHistogram[index]++;

            // Log milestone events to UI
            const total = this.stats.retryHistogram.reduce((a, b) => a + b, 0);
            if (total % 50 === 0) {
                const firstAttemptRate = this.stats.retryHistogram[0] / total * 100;
                logger.info(`[Retry Stats] 📊 ${total} requests | ${firstAttemptRate.toFixed(1)}% success on 1st attempt`);
            }
        }
    }

    /**
     * Get retry distribution analysis
     * @returns {Array<Object>} Distribution with percentages
     */
    getRetryDistribution() {
        const total = this.stats.retryHistogram.reduce((a, b) => a + b, 0);
        if (total === 0) return [];

        return this.stats.retryHistogram.map((count, idx) => ({
            retries: idx,
            count,
            percentage: ((count / total) * 100).toFixed(1) + '%',
            label: idx === 0 ? '1st attempt' : `${idx} ${idx === 1 ? 'retry' : 'retries'}`
        }));
    }

    /**
     * Log retry histogram summary to UI
     */
    logRetryHistogram() {
        const dist = this.getRetryDistribution();
        if (dist.length === 0) {
            logger.info('[Retry Histogram] 📊 No data yet');
            return;
        }

        const summary = dist
            .filter(d => d.count > 0)
            .map(d => `${d.label}: ${d.count} (${d.percentage})`)
            .join(' | ');

        logger.info(`[Retry Histogram] 📊 ${summary}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 1.4: Request Duration Percentiles
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Calculate percentiles for request durations
     * @returns {Object|null} Percentile values or null if no data
     */
    calculatePercentiles() {
        if (this.stats.requestDurations.length < 5) return null;

        const sorted = [...this.stats.requestDurations].sort((a, b) => a - b);
        const len = sorted.length;

        // BUG-Stats-Percentile-Falsy-Zero (Statistics audit, 2026-05-09):
        // Pre-fix used `||` falsy fallback which fires when sorted[idx] === 0
        // (a legitimate zero-duration value, e.g. cached responses). For
        // [0,0,0,0,5000], the median (p50) was wrongly reported as 5000
        // (the max) instead of 0. Fix: use nullish-coalesce `??` so only
        // undefined/null trigger the fallback. Sorted is dense so the
        // fallback is now reachable only for p=1.0 which is not requested.
        // Test: tests/run-statistics-pure-logic-node.mjs (Test 1).
        const getPercentile = (p) => sorted[Math.floor(len * p)] ?? sorted[len - 1];

        const percentiles = {
            p50: getPercentile(0.50),
            p75: getPercentile(0.75),
            p90: getPercentile(0.90),
            p95: getPercentile(0.95),
            p99: getPercentile(0.99)
        };

        // Note: Warning about slow outliers is now logged in logPercentiles() instead
        // to avoid flooding logs when getStats() is called frequently

        return percentiles;
    }

    /**
     * Log percentile summary to UI
     */
    logPercentiles() {
        const p = this.calculatePercentiles();
        if (!p) {
            logger.info('[Percentiles] 📈 Need more data (min 5 requests)');
            return;
        }

        logger.info(`[Percentiles] 📈 P50: ${p.p50}ms | P75: ${p.p75}ms | P90: ${p.p90}ms | P95: ${p.p95}ms | P99: ${p.p99}ms`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 2.4: Domain Health Tracking (Enhanced)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Get health status for a specific domain
     * @param {string} domain - Domain to check
     * @returns {Object|null} Health info or null
     */
    getDomainHealth(domain) {
        const stats = this.stats.domainStats.get(domain);
        if (!stats) return null;

        const total = stats.finished + stats.failed;
        const successRate = total > 0 ? (stats.finished / total) * 100 : 0;

        return {
            domain,
            successRate: successRate.toFixed(1) + '%',
            successRateNum: successRate,
            avgDuration: stats.finished > 0 ? Math.round(stats.totalDuration / stats.finished) : 0,
            isHealthy: stats.consecutiveFailures < 3 && successRate >= 50,
            consecutiveFailures: stats.consecutiveFailures || 0,
            total
        };
    }

    /**
     * Get list of unhealthy domains
     * @param {number} [threshold=50] - Success rate threshold
     * @returns {Array<Object>} Unhealthy domains sorted by success rate
     */
    getUnhealthyDomains(threshold = 50) {
        const unhealthy = [];

        for (const [domain, stats] of this.stats.domainStats) {
            const total = (stats.finished || 0) + (stats.failed || 0);
            if (total >= 3) { // Minimum sample size
                const rate = total > 0 ? (stats.finished / total) * 100 : 0;
                if (rate < threshold || (stats.consecutiveFailures || 0) >= 3) {
                    unhealthy.push({
                        domain,
                        successRate: rate.toFixed(1) + '%',
                        failed: stats.failed,
                        consecutiveFailures: stats.consecutiveFailures || 0
                    });
                }
            }
        }

        // Note: Warning is now logged in logDomainHealth() instead  
        // to avoid flooding logs when getStats() is called frequently

        return unhealthy.sort((a, b) => parseFloat(a.successRate) - parseFloat(b.successRate));
    }

    /**
     * Log domain health summary to UI
     */
    logDomainHealth() {
        const unhealthy = this.getUnhealthyDomains();
        const totalDomains = this.stats.domainStats.size;

        if (totalDomains === 0) {
            logger.info('[Domain Health] 🌐 No domains tracked yet');
            return;
        }

        if (unhealthy.length === 0) {
            logger.info(`[Domain Health] ✅ All ${totalDomains} domains healthy`);
        } else {
            const topBad = unhealthy.slice(0, 3).map(d => `${d.domain}: ${d.successRate}`).join(', ');
            logger.warn(`[Domain Health] ⚠️ ${unhealthy.length}/${totalDomains} unhealthy: ${topBad}`);
        }
    }

    /**
     * Get current statistics summary
     * @returns {Object} Complete statistics summary
     */
    getStats() {
        const runtime = Date.now() - this.startTime;
        const runtimeSecs = runtime / 1000;

        const successRate = this.stats.requestsTotal > 0
            ? (this.stats.requestsFinished / this.stats.requestsTotal * 100)
            : 100;

        const requestsPerSecond = runtimeSecs > 0
            ? (this.stats.requestsFinished / runtimeSecs)
            : 0;

        const emailsPerMinute = runtimeSecs > 60
            ? (this.stats.emailsFound / (runtimeSecs / 60))
            : this.stats.emailsFound;

        const emailFoundRate = this.stats.businessesProcessed > 0
            ? (this.stats.businessesWithEmail / this.stats.businessesProcessed * 100)
            : 0;

        return {
            // ─────────────────────────────────────────────────────────────
            // Core counts
            // ─────────────────────────────────────────────────────────────
            requestsTotal: this.stats.requestsTotal,
            requestsFinished: this.stats.requestsFinished,
            requestsFailed: this.stats.requestsFailed,
            requestsRetried: this.stats.requestsRetried,

            // ─────────────────────────────────────────────────────────────
            // Email stats
            // ─────────────────────────────────────────────────────────────
            emailsFound: this.stats.emailsFound,
            emailsValidated: this.stats.emailsValidated,
            websitesExtracted: this.stats.websitesExtracted,
            businessesProcessed: this.stats.businessesProcessed,
            businessesWithEmail: this.stats.businessesWithEmail,

            // ─────────────────────────────────────────────────────────────
            // Rates
            // ─────────────────────────────────────────────────────────────
            successRate: successRate.toFixed(1) + '%',
            successRateNum: successRate,
            requestsPerSecond: requestsPerSecond.toFixed(2),
            emailsPerMinute: emailsPerMinute.toFixed(1),
            emailFoundRate: emailFoundRate.toFixed(1) + '%',

            // ─────────────────────────────────────────────────────────────
            // Timing
            // ─────────────────────────────────────────────────────────────
            avgRequestDurationMs: Math.round(this.stats.avgRequestDuration),
            minRequestDurationMs: this.stats.minRequestDuration === Infinity ? 0 : Math.round(this.stats.minRequestDuration),
            maxRequestDurationMs: Math.round(this.stats.maxRequestDuration),

            // ─────────────────────────────────────────────────────────────
            // Runtime
            // ─────────────────────────────────────────────────────────────
            runtimeMs: runtime,
            runtimeFormatted: this._formatDuration(runtime),

            // ─────────────────────────────────────────────────────────────
            // Data
            // ─────────────────────────────────────────────────────────────
            bytesDownloaded: this.stats.bytesDownloaded,
            bytesDownloadedFormatted: this._formatBytes(this.stats.bytesDownloaded),
            pagesDownloaded: this.stats.pagesDownloaded,

            // ─────────────────────────────────────────────────────────────
            // Errors
            // ─────────────────────────────────────────────────────────────
            errorTypes: Object.fromEntries(this.stats.errorsByType),
            cloudflareBlocks: this.stats.cloudflareBlocks,
            rateLimitHits: this.stats.rateLimitHits,
            timeouts: this.stats.timeouts,

            // ─────────────────────────────────────────────────────────────
            // Sessions (pulled from SessionPool if available)
            // ─────────────────────────────────────────────────────────────
            sessionsCreated: _sessionPoolRef?.stats?.sessionsCreated ?? this.stats.sessionsCreated,
            sessionsRetired: _sessionPoolRef?.stats?.sessionsRetired ?? this.stats.sessionsRetired,
            sessionPoolSize: _sessionPoolRef?.sessions?.size ?? 0,

            // ─────────────────────────────────────────────────────────────
            // Memory
            // ─────────────────────────────────────────────────────────────
            peakMemoryMB: (this.stats.peakMemoryUsage / 1024 / 1024).toFixed(1),

            // ─────────────────────────────────────────────────────────────
            // CRAWLEE FEATURE 1.1: Retry Histogram
            // ─────────────────────────────────────────────────────────────
            retryHistogram: this.stats.retryHistogram,
            retryDistribution: this.getRetryDistribution(),

            // ─────────────────────────────────────────────────────────────
            // CRAWLEE FEATURE 1.4: Request Duration Percentiles
            // ─────────────────────────────────────────────────────────────
            percentiles: this.calculatePercentiles(),

            // ─────────────────────────────────────────────────────────────
            // CRAWLEE FEATURE 2.4: Domain Health
            // ─────────────────────────────────────────────────────────────
            unhealthyDomains: this.getUnhealthyDomains(),
            totalDomainsTracked: this.stats.domainStats.size,

            // ─────────────────────────────────────────────────────────────
            // Top error domains
            // ─────────────────────────────────────────────────────────────
            topErrorDomains: this._getTopErrorDomains(5)
        };
    }

    /**
     * Get per-domain statistics
     * @param {number} [limit=10] - Max domains to return
     * @returns {Array} Array of domain stats
     */
    getDomainStats(limit = 10) {
        return Array.from(this.stats.domainStats.entries())
            .map(([domain, stats]) => ({
                domain,
                ...stats,
                successRate: stats.total > 0
                    ? (stats.success / stats.total * 100).toFixed(1) + '%'
                    : '0%',
                avgDuration: stats.total > 0
                    ? Math.round(stats.totalDuration / stats.total)
                    : 0
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, limit);
    }

    /**
     * Log current progress to console
     */
    logProgress() {
        const stats = this.getStats();

        const box = `
╔════════════════════════════════════════════════════════════════════╗
║                     GHOST MAP PRO STATISTICS                       ║
╠════════════════════════════════════════════════════════════════════╣
║ Runtime: ${stats.runtimeFormatted.padEnd(15)} Memory: ${(stats.peakMemoryMB + ' MB').padEnd(12)} ║
╠════════════════════════════════════════════════════════════════════╣
║ Requests:  ${String(stats.requestsFinished).padStart(5)} / ${String(stats.requestsTotal).padEnd(5)}    Success Rate: ${stats.successRate.padEnd(8)}  ║
║ Retried:   ${String(stats.requestsRetried).padStart(5)}            Failed: ${String(stats.requestsFailed).padEnd(5)}          ║
╠════════════════════════════════════════════════════════════════════╣
║ Businesses: ${String(stats.businessesProcessed).padStart(4)}    With Email: ${String(stats.businessesWithEmail).padStart(4)} (${stats.emailFoundRate.padEnd(6)})  ║
║ Emails:     ${String(stats.emailsFound).padStart(4)}    Rate: ${(stats.emailsPerMinute + '/min').padEnd(12)}              ║
╠════════════════════════════════════════════════════════════════════╣
║ Avg Duration: ${(stats.avgRequestDurationMs + 'ms').padEnd(8)}  Speed: ${(stats.requestsPerSecond + ' req/s').padEnd(12)}     ║
║ Downloaded:   ${stats.bytesDownloadedFormatted.padEnd(10)}  Pages: ${String(stats.pagesDownloaded).padEnd(6)}           ║
╠════════════════════════════════════════════════════════════════════╣
║ CF Blocks: ${String(stats.cloudflareBlocks).padStart(3)} │ Rate Limits: ${String(stats.rateLimitHits).padStart(3)} │ Timeouts: ${String(stats.timeouts).padEnd(3)}    ║
║ Sessions: ${String(stats.sessionsRetired).padStart(3)} retired / ${String(stats.sessionsCreated).padEnd(3)} created                      ║
╚════════════════════════════════════════════════════════════════════╝`;

        logger.info(box.trim());
    }

    /**
     * Get compact stats string for UI display
     * @returns {string} Compact stats string
     */
    getCompactStats() {
        const stats = this.getStats();
        return `📊 ${stats.requestsFinished}/${stats.requestsTotal} (${stats.successRate}) | ` +
            `📧 ${stats.emailsFound} emails | ` +
            `⏱️ ${stats.runtimeFormatted}`;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURES: Combined Status Logging
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Log comprehensive Crawlee statistics summary to UI viewlog
     * Call this periodically (e.g., every 30 seconds during scraping)
     */
    logCrawleeStats() {
        const stats = this.getStats();

        // Header
        logger.info('══════════════════════════════════════════════════════════════');
        logger.info('📊 CRAWLEE ENHANCED STATISTICS REPORT');
        logger.info('══════════════════════════════════════════════════════════════');

        // Basic stats
        logger.info(`[Overview] ✅ ${stats.requestsFinished} completed | ❌ ${stats.requestsFailed} failed | 🔄 ${stats.requestsRetried} retried | ${stats.successRate} success`);

        // FEATURE 1.1: Retry Histogram
        if (stats.retryDistribution && stats.retryDistribution.length > 0) {
            const retryStats = stats.retryDistribution
                .filter(d => d.count > 0)
                .map(d => `${d.label}: ${d.count}`)
                .join(' | ');
            logger.info(`[Retry Histogram] 📈 ${retryStats}`);
        }

        // FEATURE 1.4: Percentiles
        if (stats.percentiles) {
            const p = stats.percentiles;
            logger.info(`[Percentiles] ⏱️ P50: ${p.p50}ms | P90: ${p.p90}ms | P99: ${p.p99}ms`);
        }

        // FEATURE 2.4: Domain Health
        if (stats.unhealthyDomains && stats.unhealthyDomains.length > 0) {
            const topUnhealthy = stats.unhealthyDomains.slice(0, 3)
                .map(d => `${d.domain}: ${d.successRate}`)
                .join(', ');
            logger.warn(`[Domain Health] ⚠️ ${stats.unhealthyDomains.length} unhealthy: ${topUnhealthy}`);
        } else if (stats.totalDomainsTracked > 0) {
            logger.info(`[Domain Health] ✅ All ${stats.totalDomainsTracked} domains healthy`);
        }

        // Errors summary
        if (stats.cloudflareBlocks > 0 || stats.rateLimitHits > 0 || stats.timeouts > 0) {
            logger.warn(`[Blocks] 🛡️ CF: ${stats.cloudflareBlocks} | 429: ${stats.rateLimitHits} | Timeout: ${stats.timeouts}`);
        }

        logger.info('══════════════════════════════════════════════════════════════');
    }

    /**
     * Get Crawlee stats as structured object for UI display
     * @returns {Object} Crawlee-specific stats
     */
    getCrawleeStats() {
        const stats = this.getStats();
        return {
            retryHistogram: stats.retryHistogram,
            retryDistribution: stats.retryDistribution,
            percentiles: stats.percentiles,
            unhealthyDomains: stats.unhealthyDomains,
            totalDomainsTracked: stats.totalDomainsTracked,
            firstAttemptSuccessRate: stats.retryDistribution?.length > 0
                ? stats.retryDistribution[0].percentage
                : 'N/A'
        };
    }

    // M8-BUG6: Removed write-only persist() and restore() methods
    // restore() was a no-op (read data but never applied it)
    // persist() wrote data that was never meaningfully consumed

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE HELPER METHODS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Update per-domain statistics
     * @private
     */
    _updateDomainStats(domain, success, duration, emailsFound) {
        // ═══════════════════════════════════════════════════════════════════════════════
        // SL-010 FIX: MAX_TRACKED_DOMAINS is intentionally a local constant, not CONFIG
        // WHY: 500 is an optimal value for memory/performance tradeoff (~500 * 100bytes = 50KB)
        // This limit works with EVICTION_AGE_MS to automatically purge stale domains
        // CHANGE ONLY IF: Memory profiling shows domain stats is a bottleneck (unlikely)
        // ═══════════════════════════════════════════════════════════════════════════════
        // P2-010 FIX: Evict old domain stats to prevent unbounded memory growth
        const MAX_TRACKED_DOMAINS = 500;
        const EVICTION_AGE_MS = 30 * 60 * 1000; // 30 minutes

        if (this.stats.domainStats.size >= MAX_TRACKED_DOMAINS) {
            const now = Date.now();
            let evictionCount = 0;
            for (const [d, s] of this.stats.domainStats) {
                if (now - s.lastSeen > EVICTION_AGE_MS) {
                    this.stats.domainStats.delete(d);
                    evictionCount++;
                }
            }
            if (evictionCount > 0) {
                logger.debug(`[Statistics] Evicted ${evictionCount} stale domain stats`);
            }
        }

        if (!this.stats.domainStats.has(domain)) {
            this.stats.domainStats.set(domain, {
                total: 0,
                success: 0,
                finished: 0, // CRAWLEE: Alias for success
                failed: 0,
                totalDuration: 0,
                emailsFound: 0,
                // CRAWLEE FEATURE 2.4: Enhanced tracking
                consecutiveFailures: 0,
                firstSeen: Date.now(),
                lastSeen: Date.now()
            });
        }

        const stats = this.stats.domainStats.get(domain);
        stats.total++;
        stats.totalDuration += duration;
        stats.emailsFound += emailsFound;
        stats.lastSeen = Date.now();

        if (success) {
            stats.success++;
            stats.finished++; // CRAWLEE: Keep both for compatibility
            stats.consecutiveFailures = 0; // Reset on success
        } else {
            stats.failed++;
            stats.consecutiveFailures++;

            // CRAWLEE: Log warning for domains with 3+ consecutive failures
            if (stats.consecutiveFailures === 3) {
                logger.warn(`[Domain Health] ⚠️ ${domain}: 3 consecutive failures`);
                this.stats.unhealthyDomains.add(domain);
            }
        }
    }

    /**
     * Get top error domains
     * @private
     */
    _getTopErrorDomains(limit) {
        return Array.from(this.stats.domainStats.entries())
            .filter(([_, stats]) => stats.failed > 0)
            .map(([domain, stats]) => ({
                domain,
                failures: stats.failed,
                total: stats.total,
                rate: ((stats.failed / stats.total) * 100).toFixed(0) + '%'
            }))
            .sort((a, b) => b.failures - a.failures)
            .slice(0, limit);
    }

    /**
     * Categorize error type from error message
     * @private
     */
    _categorizeError(error) {
        const message = (typeof error === 'string' ? error : error.message || '').toLowerCase();

        if (message.includes('cloudflare') || message.includes('cf-') || message.includes('cf_chl')) {
            return 'cloudflare';
        }
        if (message.includes('429') || message.includes('rate limit') || message.includes('too many')) {
            return 'rate_limit';
        }
        if (message.includes('timeout') || message.includes('abort')) {
            return 'timeout';
        }
        if (message.includes('403') || message.includes('forbidden')) {
            return 'forbidden';
        }
        if (message.includes('404') || message.includes('not found')) {
            return 'not_found';
        }
        if (message.includes('500') || message.includes('server error')) {
            return 'server_error';
        }
        // LIB-17 FIX (2026-05-10): pre-fix the 'network' branch matched the
        // generic substring 'failed', which absorbed almost every other
        // failure mode that used the word "failed" in its message ("login
        // failed", "validation failed", "build failed", "save failed", ...).
        // Net effect: the network bucket reflected nothing about real
        // network problems and was useless for triage.
        // Now: explicit keywords that genuinely indicate transport-layer
        // errors, plus the more specific phrase 'failed to fetch' (the
        // actual browser-emitted message for fetch-level errors). The DNS
        // and SSL branches below already handle their own buckets.
        if (
            message.includes('network')
            || message.includes('failed to fetch')
            || message.includes('net::err')
            || message.includes('connection refused')
            || message.includes('econnrefused')
            || message.includes('econnreset')
            || message.includes('socket hang up')
        ) {
            return 'network';
        }
        if (message.includes('dns') || message.includes('resolve') || message.includes('enotfound')) {
            return 'dns';
        }
        if (message.includes('ssl') || message.includes('certificate') || message.includes('tls')) {
            return 'ssl';
        }

        return 'other';
    }

    /**
     * Check and record memory usage
     * @private
     */
    _checkMemory() {
        if (typeof performance !== 'undefined' && performance.memory) {
            const used = performance.memory.usedJSHeapSize;
            if (used > this.stats.peakMemoryUsage) {
                this.stats.peakMemoryUsage = used;
            }
        }
    }

    /**
     * Calculate array average
     * @private
     */
    _calculateAverage(arr) {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    /**
     * Format duration in human readable form
     * @private
     */
    _formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Format bytes in human readable form
     * @private
     */
    _formatBytes(bytes) {
        if (bytes === 0) return '0 B';

        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

let _instance = null;

/**
 * Get the singleton CrawlerStatistics instance
 * @param {Object} [options] - Override options (only used on first call)
 * @returns {CrawlerStatistics} Singleton instance
 */
export function getStatistics(options = {}) {
    if (!_instance) {
        _instance = new CrawlerStatistics(options);
    }
    return _instance;
}

/**
 * SL-002 FIX: Reset the statistics singleton (for factory reset)
 * Clears all statistics and stops auto-logging/persisting
 * 
 * HISTORICAL NOTE: Previously called stopAutoLog() which didn't exist.
 * Now correctly calls stop() which clears intervals and persists final state.
 * Verified working: 2024-12-17 (Block M3)
 */
export function resetStatistics() {
    if (_instance) {
        _instance.reset();  // Clear all stats to initial state
        _instance.stop();   // Stop intervals, persist final state
    }
}

export default CrawlerStatistics;

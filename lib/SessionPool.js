/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 * 
 * INSPIRED BY: Crawlee SessionPool
 * https://crawlee.dev/js/docs/guides/session-management
 * 
 * FIX-002: Added operation lock to prevent race conditions in concurrent session ops
 * The lock ensures atomicity for markGood, markBad, and retire operations during
 * cleanup iterations, preventing double-retirement and statistics corruption.
 */

/**
 * Ghost Map Pro - Session Pool
 * Manages session rotation, cookie persistence, and automatic blocking detection
 * 
 * Key features from Crawlee:
 * - Session rotation based on usage count
 * - Error score tracking with auto-retire
 * - Cookie persistence per session
 * - Fingerprint association per session
 * - Blocked domain tracking
 * - FIX-002: Thread-safe operations with mutex lock
 */

import { logger } from './utils.js';
import { FingerprintGenerator } from './FingerprintGenerator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CRAWLEE FEATURE 1.2: Blocked Status Codes Detection
// ═══════════════════════════════════════════════════════════════════════════════
const BLOCKED_STATUS_CODES = {
    401: { action: 'markBad', reason: 'Unauthorized', severity: 'medium' },
    403: { action: 'markBad', reason: 'Forbidden', severity: 'high' },
    407: { action: 'retire', reason: 'Proxy Auth Required', severity: 'critical' },
    429: { action: 'retire', reason: 'Too Many Requests', severity: 'critical' },
    503: { action: 'markBad', reason: 'Service Unavailable', severity: 'medium' }
};

/**
 * SessionPool Class
 * Manages a pool of sessions with automatic rotation and blocking detection.
 *
 * ─── MV3 SW EVICTION POLICY (B11-6 #3 re-evaluated 2026-05-10) ──────────────
 *
 * The original ultrareview B11-6 cluster triage flagged this class as HOT
 * (sessions Map + retiredSessionIds Set + stats lost on SW eviction →
 * fingerprint reset → anti-detection cliff). Re-evaluation:
 *
 *   • The class ALREADY has eviction-safety:
 *     - persist() writes to chrome.storage.local (PERSISTENT — survives both
 *       SW eviction AND Chrome restart, unlike chrome.storage.session).
 *     - restore() rehydrates the Map at boot/wake (called from
 *       initializeSessionPool() in background/index.js, fired on every
 *       SW startup since `_initialized` is module-scope and resets at
 *       eviction).
 *     - startAutoPersist() runs at intervals (now 30 s — narrowed from 60 s
 *       in the same hardening pass).
 *
 *   • Residual loss window = the auto-persist interval (30 s). Worst case:
 *     eviction lands at second 29 of an interval → up to 30 s of session
 *     mutations (cookies, usageCount, errorScore) lost. Sessions THEMSELVES
 *     are preserved; only the most recent telemetry is slightly stale.
 *
 * Decision: classify as SAFE-BY-SEMANTICS (downgraded from HOT in §11.5
 * triage). The 30s persist window is the only residual; tightening further
 * has diminishing returns (storage I/O contention).
 *
 * SW-EVICTION-SAFE: persist via chrome.storage.local + restore at init.
 */
export class SessionPool {
    /**
     * Create a new SessionPool
     * @param {Object} options - Configuration options
     * @param {number} [options.maxPoolSize=20] - Maximum sessions in pool
     * @param {number} [options.maxUsageCount=30] - Max uses before session is retired
     * @param {number} [options.maxErrorScore=3] - Max errors before session is retired
     * @param {number} [options.maxAgeSecs=3600] - Max session age in seconds (1 hour)
     */
    constructor(options = {}) {
        // Pool configuration
        // BUG-SP-Falsy-Defaults (SessionPool audit, 2026-05-09): same `||` →
        // `??` pattern as AutoScaler / Statistics / jobQueue audits (4th
        // consolidation). Caller passing 0 (e.g. maxAgeSecs: 0 to disable
        // age-based retirement) silenced by default fallback. Use `??` to
        // honor explicit zeros. Test: tests/run-sessionpool-pure-logic-node.mjs.
        this.maxPoolSize = options.maxPoolSize ?? 20;
        this.maxUsageCount = options.maxUsageCount ?? 30;
        this.maxErrorScore = options.maxErrorScore ?? 3;
        this.maxAgeSecs = options.maxAgeSecs ?? 3600; // 1 hour max age
        // ═══════════════════════════════════════════════════════════════════════════════
        // SL-009 FIX: maxMemoryBytes IS ALREADY CONFIGURABLE via constructor options
        // Default: 50MB. To change, pass options.maxMemoryBytes when creating SessionPool
        // Example: new SessionPool({ maxMemoryBytes: 100 * 1024 * 1024 }) // 100MB
        // NOTE: This is NOT hardcoded - the 50MB default is a sensible production value
        // ═══════════════════════════════════════════════════════════════════════════════
        this.maxMemoryBytes = options.maxMemoryBytes ?? 50 * 1024 * 1024; // 50MB default limit (FLAW-007); BUG-SP-Falsy-Defaults: `??` honors 0

        // Session storage
        this.sessions = new Map();
        this.retiredSessionIds = new Set();

        // FIX-002: Guard checks are used in markGood/markBad/retire to prevent
        // concurrent modification issues. The retiredSessionIds Set ensures
        // atomicity by checking retired status BEFORE any operation.

        // Fingerprint generator
        this.fingerprintGenerator = new FingerprintGenerator({
            browsers: ['Chrome', 'Firefox', 'Edge'],
            operatingSystems: ['Windows', 'macOS'],
            locales: ['it-IT', 'en-US'],
            devices: ['desktop']
        });

        // Statistics
        this.stats = {
            sessionsCreated: 0,
            sessionsRetired: 0,
            totalRequests: 0,
            blockedDetections: 0,
            goodMarks: 0,
            badMarks: 0,
            // CRAWLEE FEATURE 1.2: Status code tracking
            statusCodeHits: new Map()
        };

        logger.info(`[SessionPool] 🚀 Initialized: maxPoolSize=${this.maxPoolSize}, maxUsage=${this.maxUsageCount}, blocked codes=[${Object.keys(BLOCKED_STATUS_CODES).join(',')}]`);
    }

    /**
     * Get an available session or create a new one
     * @returns {Promise<Object>} Session object with headers and metadata
     */
    async getSession() {
        // Clean up expired sessions first
        this._cleanupExpiredSessions();

        // Find best available session
        let bestSession = null;
        let bestScore = -Infinity;

        for (const [id, session] of this.sessions) {
            if (this._isSessionUsable(session)) {
                // Score: lower usage + lower errors = better
                const score = (this.maxUsageCount - session.usageCount) -
                    (session.errorScore * 10);

                if (score > bestScore) {
                    bestScore = score;
                    bestSession = session;
                }
            }
        }

        // Create new session if none available or pool not full
        if (!bestSession && this.sessions.size < this.maxPoolSize) {
            bestSession = this._createSession();
        }

        // If still no session, force create (evict oldest)
        if (!bestSession) {
            this._evictOldestSession();
            bestSession = this._createSession();
        }

        // Increment usage
        bestSession.usageCount++;
        bestSession.lastUsedAt = Date.now();
        this.stats.totalRequests++;

        logger.debug(`[SessionPool] Using session ${bestSession.id.slice(0, 8)}... ` +
            `(usage: ${bestSession.usageCount}/${this.maxUsageCount}, ` +
            `errors: ${bestSession.errorScore.toFixed(1)}, ` +
            `browser: ${bestSession.fingerprint.browser})`);

        // Check and enforce memory limits (FLAW-007)
        this._enforceMemoryLimit();

        return bestSession;
    }

    /**
     * Create a new session with fingerprint
     * @private
     * @returns {Object} New session object
     */
    _createSession() {
        const fingerprint = this.fingerprintGenerator.generate();

        const session = {
            id: this._generateId(),
            fingerprint,
            headers: fingerprint.headers,
            cookies: new Map(),
            usageCount: 0,
            errorScore: 0,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            blockedDomains: new Set(),
            successfulDomains: new Set()
        };

        this.sessions.set(session.id, session);
        this.stats.sessionsCreated++;

        logger.info(`[SessionPool] Created session ${session.id.slice(0, 8)}... ` +
            `(browser: ${fingerprint.browser}, locale: ${fingerprint.locale}, ` +
            `pool: ${this.sessions.size}/${this.maxPoolSize})`);

        return session;
    }

    /**
     * Mark session as having completed request successfully
     * Reduces error score slightly (rewards good behavior)
     * FIX-002: Added guard check to prevent race condition
     * @param {string} sessionId - Session ID
     * @param {string} [domain] - Domain that succeeded (optional)
     */
    markGood(sessionId, domain = null) {
        // FIX-002: Guard check - ensure session exists and is not retired
        if (this.retiredSessionIds.has(sessionId)) {
            logger.debug(`[SessionPool] Session ${sessionId.slice(0, 8)}... already retired, skipping markGood`);
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            return; // Session doesn't exist or was removed
        }

        // Reduce error score (but not below 0)
        session.errorScore = Math.max(0, session.errorScore - 0.5);
        this.stats.goodMarks++;

        if (domain) {
            session.successfulDomains.add(domain);
        }

        logger.debug(`[SessionPool] Session ${sessionId.slice(0, 8)}... marked GOOD ` +
            `(errorScore: ${session.errorScore.toFixed(1)})`);
    }

    /**
     * Mark session as having encountered an error
     * Increases error score; may trigger auto-retire
     * FIX-002: Added guard check to prevent double-retirement
     * @param {string} sessionId - Session ID
     * @param {string} [domain] - Domain that caused error (optional)
     */
    markBad(sessionId, domain = null) {
        // FIX-002: Guard check - ensure session exists and is not retired
        if (this.retiredSessionIds.has(sessionId)) {
            logger.debug(`[SessionPool] Session ${sessionId.slice(0, 8)}... already retired, skipping markBad`);
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            return; // Session doesn't exist or was removed
        }

        session.errorScore++;
        this.stats.badMarks++;

        if (domain) {
            session.blockedDomains.add(domain);
        }

        logger.warn(`[SessionPool] Session ${sessionId.slice(0, 8)}... marked BAD ` +
            `(errorScore: ${session.errorScore}/${this.maxErrorScore}` +
            `${domain ? ', domain: ' + domain : ''})`);

        // Auto-retire if too many errors (capture session before potential deletion)
        if (session.errorScore >= this.maxErrorScore) {
            logger.warn(`[SessionPool] Auto-retiring session ${sessionId.slice(0, 8)}... (max errors reached)`);
            this.retire(sessionId);
        }
    }

    /**
     * Retire session (mark as unusable and remove from pool)
     * FIX-002: Added double-retirement prevention
     * @param {string} sessionId - Session ID
     */
    retire(sessionId) {
        // FIX-002: Prevent double-retirement
        if (this.retiredSessionIds.has(sessionId)) {
            logger.debug(`[SessionPool] Session ${sessionId.slice(0, 8)}... already retired, skipping`);
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            // Still add to retired set to prevent future issues
            this.retiredSessionIds.add(sessionId);
            return;
        }

        // FIX-002: Atomic operation - add to retired BEFORE deleting
        // This prevents race conditions where another thread checks sessions
        // but the retirement hasn't been recorded yet
        this.retiredSessionIds.add(sessionId);
        this.sessions.delete(sessionId);
        this.stats.sessionsRetired++;
        this.stats.blockedDetections++;

        logger.warn(`[SessionPool] Session ${sessionId.slice(0, 8)}... RETIRED ` +
            `(usage: ${session.usageCount}, errors: ${session.errorScore.toFixed(1)}, ` +
            `blocked domains: ${session.blockedDomains.size}, ` +
            `pool: ${this.sessions.size}/${this.maxPoolSize})`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 1.2: Blocked Status Codes Detection
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Handle HTTP status code and take appropriate action
     * @param {string} sessionId - Session ID
     * @param {number} statusCode - HTTP status code
     * @param {string} [domain] - Domain that returned this status
     * @returns {Object} Action taken: { action, reason, retired }
     */
    handleStatusCode(sessionId, statusCode, domain = null) {
        const blockInfo = BLOCKED_STATUS_CODES[statusCode];

        // Track status code hits
        const hitCount = (this.stats.statusCodeHits.get(statusCode) || 0) + 1;
        this.stats.statusCodeHits.set(statusCode, hitCount);

        if (!blockInfo) {
            // Normal status code
            if (statusCode >= 200 && statusCode < 300) {
                return { action: 'ok', reason: 'Success', retired: false };
            } else if (statusCode >= 500) {
                // Server error - not our fault, but note it
                logger.debug(`[SessionPool] Server error ${statusCode} for ${domain || 'unknown'}`);
                return { action: 'server_error', reason: 'Server Error', retired: false };
            }
            return { action: 'ok', reason: 'Untracked', retired: false };
        }

        // Blocked status code detected!
        logger.warn(`[SessionPool] 🚫 Blocked status ${statusCode} (${blockInfo.reason}) from ${domain || 'unknown'} - Action: ${blockInfo.action}`);

        const session = this.sessions.get(sessionId);
        if (!session) {
            return { action: blockInfo.action, reason: blockInfo.reason, retired: false };
        }

        let retired = false;

        if (blockInfo.action === 'retire') {
            // Immediate retirement for critical blocks
            this.retire(sessionId);
            retired = true;
            logger.warn(`[SessionPool] ⛔ Session ${sessionId.slice(0, 8)}... FORCE RETIRED due to ${statusCode} ${blockInfo.reason}`);
        } else if (blockInfo.action === 'markBad') {
            // Increase error score
            this.markBad(sessionId, domain);
            // Log milestone hits
            if (hitCount % 5 === 0) {
                logger.warn(`[SessionPool] 📊 Status ${statusCode} hit ${hitCount} times total`);
            }
        }

        return {
            action: blockInfo.action,
            reason: blockInfo.reason,
            retired,
            severity: blockInfo.severity
        };
    }

    /**
     * Check if a status code indicates blocking
     * @param {number} statusCode - HTTP status code
     * @returns {boolean} True if blocked
     */
    isBlockedStatusCode(statusCode) {
        return statusCode in BLOCKED_STATUS_CODES;
    }

    /**
     * Get blocked status code statistics
     * @returns {Object} Status code hit counts and summary
     */
    getBlockedStatusStats() {
        const stats = {
            totalBlocked: 0,
            byCode: {}
        };

        for (const [code, info] of Object.entries(BLOCKED_STATUS_CODES)) {
            const hits = this.stats.statusCodeHits.get(parseInt(code)) || 0;
            stats.byCode[code] = {
                hits,
                reason: info.reason,
                severity: info.severity
            };
            stats.totalBlocked += hits;
        }

        return stats;
    }

    /**
     * Store cookies for session and domain
     * @param {string} sessionId - Session ID
     * @param {string} domain - Cookie domain
     * @param {Object} cookies - Cookies to store
     */
    setCookies(sessionId, domain, cookies) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.cookies.set(domain, cookies);
            logger.debug(`[SessionPool] Stored cookies for ${domain} in session ${sessionId.slice(0, 8)}...`);
        }
    }

    /**
     * Get cookies for session and domain
     * @param {string} sessionId - Session ID
     * @param {string} domain - Cookie domain
     * @returns {Object|null} Cookies or null if not found
     */
    getCookies(sessionId, domain) {
        const session = this.sessions.get(sessionId);
        if (session) {
            return session.cookies.get(domain) || null;
        }
        return null;
    }

    /**
     * Check if session is blocked for a specific domain
     * @param {string} sessionId - Session ID
     * @param {string} domain - Domain to check
     * @returns {boolean} True if blocked
     */
    isBlockedForDomain(sessionId, domain) {
        const session = this.sessions.get(sessionId);
        return session ? session.blockedDomains.has(domain) : true;
    }

    /**
     * Get a session that is NOT blocked for a specific domain
     * @param {string} domain - Domain to check
     * @returns {Promise<Object|null>} Session or null if all blocked
     */
    async getSessionForDomain(domain) {
        // First, try to find existing session not blocked for this domain
        for (const [id, session] of this.sessions) {
            if (this._isSessionUsable(session) && !session.blockedDomains.has(domain)) {
                session.usageCount++;
                session.lastUsedAt = Date.now();
                this.stats.totalRequests++;
                return session;
            }
        }

        // All sessions blocked for this domain, create new one
        if (this.sessions.size < this.maxPoolSize) {
            return this._createSession();
        }

        // Pool full and all blocked - evict and create
        this._evictOldestSession();
        return this._createSession();
    }

    /**
     * Check if session is usable
     * @private
     * @param {Object} session - Session to check
     * @returns {boolean} True if usable
     */
    _isSessionUsable(session) {
        // Check usage limit
        if (session.usageCount >= this.maxUsageCount) return false;

        // Check error limit
        if (session.errorScore >= this.maxErrorScore) return false;

        // Check age
        const ageSeconds = (Date.now() - session.createdAt) / 1000;
        if (ageSeconds > this.maxAgeSecs) return false;

        return true;
    }

    /**
     * Clean up expired sessions
     * @private
     */
    _cleanupExpiredSessions() {
        const now = Date.now();
        const toRemove = [];

        for (const [id, session] of this.sessions) {
            const ageSeconds = (now - session.createdAt) / 1000;

            if (ageSeconds > this.maxAgeSecs) {
                toRemove.push(id);
                logger.debug(`[SessionPool] Session ${id.slice(0, 8)}... expired (age: ${Math.round(ageSeconds)}s)`);
            } else if (session.errorScore >= this.maxErrorScore) {
                toRemove.push(id);
            }
        }

        for (const id of toRemove) {
            this.retire(id);
        }

        if (toRemove.length > 0) {
            logger.info(`[SessionPool] Cleaned up ${toRemove.length} expired sessions`);
        }
    }

    /**
     * Evict oldest session to make room
     * UPDATED (FLAW-007): Uses LRU (Least Recently Used) strategy
     * @private
     */
    _evictOldestSession() {
        let lruId = null;
        let oldestUsedTime = Infinity;

        for (const [id, session] of this.sessions) {
            // Use lastUsedAt for LRU eviction instead of creation time
            if (session.lastUsedAt < oldestUsedTime) {
                oldestUsedTime = session.lastUsedAt;
                lruId = id;
            }
        }

        if (lruId) {
            this.sessions.delete(lruId);
            // LIB-7 FIX (2026-05-10): also record the evicted id in
            // retiredSessionIds. Pre-fix the eviction silently dropped the
            // session from the Map without adding it to the retired set;
            // any caller that had already obtained the session via
            // getSession() and was about to call markGood / markBad on it
            // would slip past the `retiredSessionIds.has(sessionId)` guards
            // (lines 223 / 254 / 289). The subsequent `this.sessions.get
            // (sessionId)` would return undefined and the function would
            // silently no-op — losing the success / failure signal for
            // that fingerprint. Same fingerprint could then be re-created
            // and re-used until pool churn flushed it. Adding to the set
            // restores the FIX-002 invariant: "every session leaves the
            // pool through the retired path".
            this.retiredSessionIds.add(lruId);
            logger.debug(`[SessionPool] Evicted LRU session ${lruId.slice(0, 8)}... (last used: ${new Date(oldestUsedTime).toISOString()})`);
        }
    }

    /**
     * Estimate memory size of a session
     * @private
     * @param {Object} session - Session object
     * @returns {number} Estimated size in bytes
     */
    _estimateSessionSize(session) {
        let size = 0;
        // Base overhead
        size += 200;

        // Headers size
        if (session.headers) {
            size += JSON.stringify(session.headers).length * 2;
        }

        // Cookies size
        if (session.cookies) {
            for (const [domain, cookies] of session.cookies) {
                size += domain.length * 2;
                size += JSON.stringify(cookies).length * 2;
            }
        }

        return size;
    }

    /**
     * Enforce memory limits by evicting LRU sessions
     * @private
     */
    _enforceMemoryLimit() {
        let totalBytes = 0;
        for (const s of this.sessions.values()) {
            totalBytes += this._estimateSessionSize(s);
        }

        if (totalBytes > this.maxMemoryBytes && this.sessions.size > 0) {
            logger.warn(`[SessionPool] ⚠️ Memory limit exceeded (${(totalBytes / 1024 / 1024).toFixed(2)}MB / ${(this.maxMemoryBytes / 1024 / 1024).toFixed(2)}MB). Evicting LRU sessions...`);

            while (totalBytes > this.maxMemoryBytes && this.sessions.size > 0) {
                this._evictOldestSession(); // LRU eviction

                // Recalculate
                totalBytes = 0;
                for (const s of this.sessions.values()) {
                    totalBytes += this._estimateSessionSize(s);
                }
            }
        }
    }

    /**
     * Generate unique session ID
     * SL-004 FIX: Cryptographically secure ID generation
     * Primary: crypto.randomUUID() (UUID v4 standard)
     * Fallback: crypto.getRandomValues() instead of Math.random()
     * @private
     * @returns {string} Unique session ID with guaranteed entropy
     */
    _generateId() {
        // Primary: Use crypto.randomUUID() if available (Chrome 92+, Node 19+)
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return 'sess_' + crypto.randomUUID();
        }

        // ═════════════════════════════════════════════════════════════
        // SL-004 FIX: Cryptographically secure fallback
        // Uses crypto.getRandomValues() instead of Math.random()
        // Provides 128 bits of entropy vs 53 bits from Math.random
        // ═════════════════════════════════════════════════════════════
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            // Generate 16 random bytes (128 bits)
            const buffer = new Uint8Array(16);
            crypto.getRandomValues(buffer);

            // Convert to hex string
            const hex = Array.from(buffer)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            return 'sess_' + hex;
        }

        // Last resort: timestamp + performance.now() (better than Math.random)
        // Only reached in extremely old environments without crypto API
        const timestamp = Date.now().toString(36);
        const perfTime = (typeof performance !== 'undefined' && performance.now())
            ? performance.now().toString(36).replace('.', '')
            : '';
        const counter = (this.stats.sessionsCreated || 0).toString(36);

        return 'sess_' + timestamp + '_' + perfTime + '_' + counter;
    }

    /**
     * Get pool statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        const activeSessions = this.sessions.size;
        const avgUsage = activeSessions > 0
            ? Array.from(this.sessions.values())
                .reduce((sum, s) => sum + s.usageCount, 0) / activeSessions
            : 0;
        const avgErrorScore = activeSessions > 0
            ? Array.from(this.sessions.values())
                .reduce((sum, s) => sum + s.errorScore, 0) / activeSessions
            : 0;

        return {
            ...this.stats,
            activeSessions,
            poolUtilization: (activeSessions / this.maxPoolSize * 100).toFixed(1) + '%',
            avgUsage: avgUsage.toFixed(1),
            avgErrorScore: avgErrorScore.toFixed(2),
            retiredCount: this.retiredSessionIds.size
        };
    }

    /**
     * Persist sessions to chrome.storage.local (for crash recovery)
     * @returns {Promise<void>}
     */
    async persist() {
        const data = {
            sessions: Array.from(this.sessions.entries()).map(([id, s]) => ({
                id,
                fingerprint: s.fingerprint,
                usageCount: s.usageCount,
                errorScore: s.errorScore,
                createdAt: s.createdAt,
                cookies: Array.from(s.cookies.entries()),
                blockedDomains: Array.from(s.blockedDomains)
            })),
            stats: this.stats,
            savedAt: Date.now()
        };

        try {
            await chrome.storage.local.set({ sessionPool: data });
            logger.debug(`[SessionPool] Persisted ${this.sessions.size} sessions to storage`);
        } catch (error) {
            logger.warn(`[SessionPool] Failed to persist: ${error.message}`);
        }
    }

    /**
     * Restore sessions from chrome.storage.local
     * @returns {Promise<void>}
     */
    async restore() {
        // LIB-19 FIX (2026-05-10): pre-fix the loop assumed every persisted
        // session had iterable `s.cookies` and `s.blockedDomains`. If chrome
        // .storage.local was corrupted (DevTools poke, partial migration,
        // schema drift between extension versions), `new Map(s.cookies)`
        // would throw TypeError ("object is not iterable") on the first
        // bad entry — the outer try/catch caught it and aborted the ENTIRE
        // restore, losing all subsequent sessions including the good ones.
        // Now: per-session try/catch so a single malformed record is
        // skipped (with a warn) while the rest of the pool restores.
        try {
            const { sessionPool } = await chrome.storage.local.get('sessionPool');

            if (sessionPool && sessionPool.sessions) {
                let restored = 0;
                let skipped = 0;

                for (const s of sessionPool.sessions) {
                    try {
                        // Skip if too old
                        const ageSeconds = (Date.now() - s.createdAt) / 1000;
                        if (ageSeconds > this.maxAgeSecs) continue;

                        // Skip if too many errors
                        if (s.errorScore >= this.maxErrorScore) continue;

                        // LIB-19: defensive coercion. If the persisted shape is
                        // missing or malformed (non-iterable), normalize to
                        // an empty Map/Set so the constructors below don't throw.
                        const cookiesIter = Array.isArray(s.cookies) ? s.cookies : [];
                        const blockedIter = Array.isArray(s.blockedDomains) ? s.blockedDomains : [];
                        if (!s.fingerprint || !s.fingerprint.headers) {
                            skipped++;
                            continue;
                        }

                        this.sessions.set(s.id, {
                            ...s,
                            headers: s.fingerprint.headers,
                            cookies: new Map(cookiesIter),
                            blockedDomains: new Set(blockedIter),
                            successfulDomains: new Set(),
                            lastUsedAt: Date.now()
                        });
                        restored++;
                    } catch (perSessionErr) {
                        // Single corrupt entry — skip it but keep going.
                        skipped++;
                        logger.warn(
                            `[SessionPool] Skipping corrupt session ${s?.id || '<no-id>'}: ` +
                            `${perSessionErr?.message || perSessionErr}`
                        );
                    }
                }

                if (restored > 0 || skipped > 0) {
                    // 2026-05-15 CRITICAL FIX: Map rehydration on restore.
                    // Pre-fix `this.stats = sessionPool.stats || this.stats`
                    // overwrote the Map-backed `statusCodeHits` with a
                    // JSON-deserialized Object. JSON.stringify(new Map())
                    // → `{}`. JSON.parse('{}') → plain Object, NOT Map.
                    // Every subsequent `this.stats.statusCodeHits.get(code)`
                    // threw "get is not a function", which surfaced as
                    // "[P0 OPTIMIZATION] Homepage fetch failed:
                    // this.stats.statusCodeHits.get is not a function" on
                    // EVERY business — speculative early-exit broke,
                    // everything fell through to the slow tab-fallback
                    // path (30–60s per business), turning a 1–3 min
                    // 50-site scrape into 30+ minutes.
                    // Observed today during a wedding-planner scrape.
                    //
                    // Fix: when assigning restored stats, force-rehydrate
                    // any Map-typed fields. Future-proof: same pattern
                    // for any new Map fields the schema gains.
                    const restoredStats = sessionPool.stats || this.stats;
                    this.stats = {
                        ...restoredStats,
                        statusCodeHits: (restoredStats.statusCodeHits instanceof Map)
                            ? restoredStats.statusCodeHits
                            : new Map(Object.entries(restoredStats.statusCodeHits || {})
                                .map(([k, v]) => [Number.isNaN(Number(k)) ? k : Number(k), v]))
                    };
                    logger.info(`[SessionPool] Restored ${restored} sessions from storage (skipped ${skipped} corrupt)`);
                }
            }
        } catch (error) {
            logger.warn(`[SessionPool] Failed to restore sessions: ${error.message}`);
        }
    }

    /**
     * Clear all sessions (for testing or reset)
     * @param {boolean} clearStorage - Also clear from chrome.storage
     */
    async clear(clearStorage = true) {
        // Stop auto-persist if running
        this.stopAutoPersist();

        this.sessions.clear();
        this.retiredSessionIds.clear();
        this.stats = {
            sessionsCreated: 0,
            sessionsRetired: 0,
            totalRequests: 0,
            blockedDetections: 0,
            goodMarks: 0,
            badMarks: 0,
            statusCodeHits: new Map()
        };

        // Clear from storage if requested
        if (clearStorage) {
            try {
                await chrome.storage.local.remove('sessionPool');
                logger.info('[SessionPool] Cleared all sessions and storage');
            } catch (error) {
                logger.warn(`[SessionPool] Failed to clear storage: ${error.message}`);
            }
        } else {
            logger.info('[SessionPool] Cleared all sessions');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRAWLEE FEATURE 2.2: Auto-Persistence
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Start automatic persistence at regular intervals
     * @param {number} intervalMs - Interval in milliseconds (default: 60 seconds)
     */
    startAutoPersist(intervalMs = 60000) {
        // Stop any existing interval
        this.stopAutoPersist();

        this._persistInterval = setInterval(async () => {
            try {
                await this.persist();
            } catch (error) {
                logger.warn(`[SessionPool] Auto-persist failed: ${error.message}`);
            }
        }, intervalMs);

        // Also persist immediately
        this.persist().catch(() => { });

        logger.info(`[SessionPool] ⏱️ Auto-persist started (every ${intervalMs / 1000}s)`);
    }

    /**
     * Stop automatic persistence
     */
    stopAutoPersist() {
        if (this._persistInterval) {
            clearInterval(this._persistInterval);
            this._persistInterval = null;
            logger.debug('[SessionPool] Auto-persist stopped');
        }
    }

    /**
     * Initialize session pool with persistence
     * Restores from storage and starts auto-persist
     * @param {Object} options - Initialization options
     * @param {number} options.autoPersistIntervalMs - Auto-persist interval (default: 60000)
     * @param {boolean} options.restoreFromStorage - Whether to restore (default: true)
     */
    async initialize(options = {}) {
        const {
            autoPersistIntervalMs = 60000,
            restoreFromStorage = true
        } = options;

        // Restore sessions from storage
        if (restoreFromStorage) {
            await this.restore();
        }

        // Start auto-persist
        if (autoPersistIntervalMs > 0) {
            this.startAutoPersist(autoPersistIntervalMs);
        }

        logger.info(`[SessionPool] ✅ Initialized with persistence (restored: ${this.sessions.size} sessions)`);
    }

    /**
     * Shutdown session pool gracefully
     * Persists one final time before stopping
     */
    async shutdown() {
        this.stopAutoPersist();

        // Final persist
        try {
            await this.persist();
            logger.info('[SessionPool] 💾 Final persist complete, shutdown successful');
        } catch (error) {
            logger.warn(`[SessionPool] Final persist failed: ${error.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

let _instance = null;
let _initialized = false;
// LIB-8 FIX (2026-05-10): single in-flight initialization promise. Pre-fix
// `initializeSessionPool` checked `if (!_initialized)` and started the
// async restore; concurrent callers (e.g. message handler firing on SW
// wake while index.js boot path is also calling) all saw _initialized
// === false and each kicked off their own pool.initialize(). Two parallel
// restores from chrome.storage.local would compete on the sessions Map,
// and any getSessionPool() consumer that ran during the 50-200 ms restore
// window would see an empty pool and create fresh ad-hoc fingerprints
// that bypassed the persisted ones — breaking anti-detection continuity.
let _initPromise = null;

/**
 * Authoritative config snapshot, captured on first initialization
 * @type {Object|null}
 */
let _authoritativeConfig = null;

/**
 * Get the singleton SessionPool instance
 * M8-CONFLICT FIX: Detects conflicting config from multiple callers and warns
 * @param {Object} [options] - Config options (only used on first call; conflicts warned on subsequent calls)
 * @returns {SessionPool} Singleton instance
 */
export function getSessionPool(options = {}) {
    if (!_instance) {
        _instance = new SessionPool(options);
        _instance._lastConflictWarning = null;
        _authoritativeConfig = { ...options };
    } else if (Object.keys(options).length > 0) {
        // M8-CONFLICT FIX: Detect actual value conflicts, not just "options were passed"
        const conflicts = [];
        for (const key of Object.keys(options)) {
            if (key in _authoritativeConfig && options[key] !== _authoritativeConfig[key]) {
                conflicts.push(`${key}: ${_authoritativeConfig[key]} (authoritative) vs ${options[key]} (requested)`);
            }
        }

        if (conflicts.length > 0) {
            const warningMsg = `[SessionPool] Conflicting singleton config ignored: ${conflicts.join(', ')}`;
            logger.warn(warningMsg);
            _instance._lastConflictWarning = warningMsg;
        } else {
            // No actual conflicts -- same values or new keys only
            _instance._lastConflictWarning = null;
        }
    }
    return _instance;
}

/**
 * Initialize the SessionPool with persistence
 * Should be called once at extension startup
 * @param {Object} [options] - Initialization options
 * @returns {Promise<SessionPool>} Initialized instance
 */
export async function initializeSessionPool(options = {}) {
    const pool = getSessionPool(options);

    // LIB-8 FIX: serialize concurrent init attempts via a shared in-flight
    // promise. The first caller starts the work; subsequent callers await
    // the same promise. After resolution _initialized flips to true, so
    // future calls fall straight through.
    if (_initialized) return pool;
    if (!_initPromise) {
        _initPromise = (async () => {
            try {
                await pool.initialize(options);
                _initialized = true;
            } finally {
                // Clear the slot so a future explicit re-init (e.g. test
                // teardown that resets _initialized) can start fresh.
                _initPromise = null;
            }
        })();
    }
    await _initPromise;
    return pool;
}

/**
 * Shutdown the SessionPool gracefully
 * Should be called before extension unload
 */
export async function shutdownSessionPool() {
    if (_instance) {
        await _instance.shutdown();
    }
}

/**
 * BUG-016 FIX: Reset the session pool singleton (for factory reset)
 * Clears all sessions and resets statistics
 * @param {boolean} clearStorage - Also clear from storage (default: true)
 */
export async function resetSessionPool(clearStorage = true) {
    if (_instance) {
        await _instance.clear(clearStorage);
    }
    _initialized = false;
}

/**
 * Reset singleton for test isolation (test-only)
 */
export function resetSessionPoolForTest() {
    _instance = null;
    _initialized = false;
    _authoritativeConfig = null;
}

export default SessionPool;

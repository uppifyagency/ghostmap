/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

import { logger } from './utils.js';
import { CONFIG } from './config.js';

/**
 * Robots.txt Compliance Service
 *
 * Fetches, parses, and enforces robots.txt rules to ensure ethical scraping.
 *
 * R12 (TIER A): Identity alignment.
 *   isAllowed(url, { headers }) extracts the User-Agent from the caller's session
 *   headers and uses the SAME User-Agent for the robots.txt fetch. This prevents
 *   the prior pattern where robots.txt was fetched as 'GhostMapProBot' while the
 *   page itself was fetched as Chrome — two identities to one origin, a trivial
 *   anti-correlation signal.
 *
 *   The User-Agent is also used as the matching key inside robots.txt rules
 *   (specific UA section vs. wildcard '*'), so a site with rules for
 *   "Googlebot" or "Mozilla/5.0" gets matched correctly when our session UA
 *   happens to look like that family.
 *
 * R3 (TIER A): Configurable strictMode.
 *   Default (strictMode=false): preserves prior fail-open behavior — when
 *   robots.txt cannot be retrieved (404, timeout, parse error, network) the
 *   request proceeds. This matches industry practice and prior product behavior.
 *
 *   strictMode=true: any inability to PROVE the URL is allowed → request blocked.
 *   This is the conservative posture for compliance-sensitive deployments.
 *   Note: a 404 (no robots.txt at all) is still treated as allow per RFC 9309 —
 *   absence of robots.txt is itself a definitive "no rules" signal.
 *   strictMode only changes the behavior on AMBIGUOUS outcomes (network failures).
 */
export class RobotsCompliance {
    /**
     * @param {Object} [options]
     * @param {boolean} [options.strictMode] - Override CONFIG.robotsCompliance.strictMode
     * @param {number} [options.cacheTTLms] - Cache TTL override
     * @param {number} [options.fetchTimeoutMs] - Fetch timeout override
     * @param {string} [options.fallbackUserAgent] - UA to use when no headers supplied
     */
    constructor(options = {}) {
        const cfg = (CONFIG && CONFIG.robotsCompliance) || {};
        this.cache = new Map(); // domain -> { rules, timestamp }
        this.cacheTTL = options.cacheTTLms ?? cfg.cacheTTLms ?? 24 * 60 * 60 * 1000;
        this.fetchTimeoutMs = options.fetchTimeoutMs ?? cfg.fetchTimeoutMs ?? 5000;
        this.fallbackUserAgent = options.fallbackUserAgent ?? cfg.fallbackUserAgent ?? 'GhostMapProBot';
        this.strictMode = options.strictMode ?? cfg.strictMode ?? false;
    }

    /**
     * Check if a URL is allowed by robots.txt.
     *
     * @param {string} url - URL to check
     * @param {Object} [options]
     * @param {Object} [options.headers] - Caller's session headers (UA extracted)
     * @param {boolean} [options.strict] - Per-call override of strictMode
     * @returns {Promise<boolean>} true if allowed, false if disallowed
     */
    async isAllowed(url, options = {}) {
        const strict = options.strict ?? this.strictMode;
        const userAgent = this._extractUserAgent(options.headers);

        let urlObj;
        try {
            urlObj = new URL(url);
        } catch (error) {
            // Malformed URL: never our fault, never strict-block on this.
            logger.warn(`[RobotsCompliance] Malformed URL ${url}: ${error.message}`);
            return true;
        }

        const domain = urlObj.hostname;
        let rules;
        try {
            rules = await this._getRules(domain, urlObj.protocol, userAgent);
        } catch (error) {
            // Network error during fetch (after timeout, after retry, etc.)
            logger.warn(`[RobotsCompliance] Rule fetch failed for ${domain}: ${error.message}`);
            return strict ? false : true;
        }

        // rules === null means: no robots.txt exists OR fetch returned non-OK non-404.
        // Per RFC 9309, absence of robots.txt = allow all. Our _fetchRobotsTxt also
        // returns null on transient failures, so strict mode treats null as "unknown".
        if (rules === null) {
            return strict ? false : true;
        }

        // rules === {} means: robots.txt fetched and parsed, but had zero directives.
        // Per RFC 9309, that's still allow-all.
        if (Object.keys(rules).length === 0) {
            return true;
        }

        const path = urlObj.pathname + (urlObj.search || '');

        // Match user-agent specific section first, then wildcard.
        // robots.txt UA matching is case-insensitive substring match per spec.
        const matchedRules = this._matchUserAgent(rules, userAgent);
        if (matchedRules) {
            return this._checkPath(path, matchedRules);
        }

        if (rules['*']) {
            return this._checkPath(path, rules['*']);
        }

        return true;
    }

    /**
     * Extract User-Agent from caller's session headers, with safe fallback.
     * @private
     */
    _extractUserAgent(headers) {
        if (headers && typeof headers === 'object') {
            // Headers may be either a plain object or a Headers instance
            if (typeof headers.get === 'function') {
                const ua = headers.get('User-Agent') || headers.get('user-agent');
                if (ua) return ua;
            } else {
                // Plain object: case-insensitive lookup
                for (const key of Object.keys(headers)) {
                    if (key.toLowerCase() === 'user-agent' && headers[key]) {
                        return headers[key];
                    }
                }
            }
        }
        return this.fallbackUserAgent;
    }

    /**
     * Match a UA string against robots.txt UA sections (case-insensitive substring).
     * Per RFC 9309, the most specific (longest) matching token wins.
     * @private
     */
    _matchUserAgent(rules, userAgent) {
        if (!userAgent) return null;
        const uaLower = userAgent.toLowerCase();

        // Sort UA tokens by length DESC for specificity-first matching
        const tokens = Object.keys(rules).filter(k => k !== '*').sort((a, b) => b.length - a.length);
        for (const token of tokens) {
            if (uaLower.includes(token.toLowerCase())) {
                return rules[token];
            }
        }
        return null;
    }

    /**
     * Get rules for a domain (cached or fetched).
     * @private
     */
    async _getRules(domain, protocol, userAgent) {
        const cached = this.cache.get(domain);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.rules;
        }

        const rules = await this._fetchRobotsTxt(domain, protocol, userAgent);
        this.cache.set(domain, { rules, timestamp: Date.now() });
        return rules;
    }

    /**
     * Fetch and parse robots.txt using the caller's User-Agent.
     * @private
     */
    async _fetchRobotsTxt(domain, protocol, userAgent) {
        const robotsUrl = `${protocol}//${domain}/robots.txt`;
        logger.debug(`[RobotsCompliance] Fetching ${robotsUrl} as UA="${userAgent.substring(0, 40)}..."`);

        const controller = new AbortController();
        // OBS-1 (2026-05-17): explicit reason → `.message` is parlante in
        // the debug log at line 208 (`Fetch error for ${domain}: ${error.message}`).
        // Name preserved as 'AbortError'; some consumers branch on it.
        const timeoutId = setTimeout(
            () => controller.abort(new DOMException(`robots.txt fetch timeout ${this.fetchTimeoutMs}ms for ${domain}`, 'AbortError')),
            this.fetchTimeoutMs
        );

        try {
            const response = await fetch(robotsUrl, {
                signal: controller.signal,
                method: 'GET',
                headers: { 'User-Agent': userAgent }
            });

            if (response.status === 404) {
                // RFC 9309 §2.4: absence of robots.txt is the DEFINITIVE
                // "no rules" outcome. We return an empty rules dict (not null)
                // so strict mode does not mis-classify this as ambiguous.
                return {};
            }

            if (!response.ok) {
                // 5xx, 403, 401, etc. — AMBIGUOUS. Caller honors strictMode.
                logger.debug(`[RobotsCompliance] HTTP ${response.status} for ${domain}`);
                return null;
            }

            const text = await response.text();
            return this._parseRobotsTxt(text);

        } catch (error) {
            // AbortError, TypeError (network), etc. — ambiguous. Caller honors strictMode.
            logger.debug(`[RobotsCompliance] Fetch error for ${domain}: ${error.message}`);
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Parse robots.txt text into a per-UA rules dict.
     * Each value: { allow: string[], disallow: string[], crawlDelay: number|null }
     * @private
     */
    _parseRobotsTxt(text) {
        const rules = {};
        let currentAgents = []; // Active UA group; multiple UAs can share a block

        const lines = text.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const uaMatch = trimmed.match(/^User-agent:\s*(.+?)(?:\s*#.*)?$/i);
            if (uaMatch) {
                const ua = uaMatch[1].trim();
                // Per RFC 9309: consecutive UA lines start a shared group
                // We track currentAgents; reset on first directive after UA.
                if (currentAgents._afterDirective) {
                    currentAgents = [];
                    currentAgents._afterDirective = false;
                }
                currentAgents.push(ua);
                if (!rules[ua]) {
                    rules[ua] = { allow: [], disallow: [], crawlDelay: null };
                }
                continue;
            }

            if (currentAgents.length === 0) continue;
            currentAgents._afterDirective = true;

            const disallowMatch = trimmed.match(/^Disallow:\s*(.*?)(?:\s*#.*)?$/i);
            if (disallowMatch) {
                const path = disallowMatch[1].trim();
                if (path) {
                    for (const ua of currentAgents) rules[ua].disallow.push(path);
                }
                continue;
            }

            const allowMatch = trimmed.match(/^Allow:\s*(.*?)(?:\s*#.*)?$/i);
            if (allowMatch) {
                const path = allowMatch[1].trim();
                if (path) {
                    for (const ua of currentAgents) rules[ua].allow.push(path);
                }
                continue;
            }

            const crawlMatch = trimmed.match(/^Crawl-delay:\s*(\d+(?:\.\d+)?)/i);
            if (crawlMatch) {
                const seconds = parseFloat(crawlMatch[1]);
                if (!isNaN(seconds) && seconds >= 0) {
                    for (const ua of currentAgents) rules[ua].crawlDelay = seconds;
                }
            }
        }

        return rules;
    }

    /**
     * Check if path is allowed by rules. Uses LONGEST-MATCH per RFC 9309 §2.2.2.
     * The most specific (longest) matching pattern wins; on tie, Allow beats Disallow.
     * @private
     */
    _checkPath(path, rules) {
        let bestAllow = null;
        let bestDisallow = null;

        for (const pattern of rules.allow || []) {
            if (this._matches(path, pattern)) {
                if (!bestAllow || pattern.length > bestAllow.length) bestAllow = pattern;
            }
        }
        for (const pattern of rules.disallow || []) {
            if (this._matches(path, pattern)) {
                if (!bestDisallow || pattern.length > bestDisallow.length) bestDisallow = pattern;
            }
        }

        if (!bestAllow && !bestDisallow) return true;
        if (bestAllow && !bestDisallow) return true;
        if (!bestAllow && bestDisallow) return false;

        // Both matched: longer wins. On tie, Allow wins.
        if (bestAllow.length >= bestDisallow.length) return true;
        return false;
    }

    /**
     * Match path against a robots.txt pattern.
     * Wildcards: '*' matches any sequence; '$' anchors end-of-string.
     * Special regex chars are escaped to prevent ReDoS (M8-SEC1 fix preserved).
     * @private
     */
    _matches(path, pattern) {
        // Empty Disallow: pattern means "allow nothing-blocked" — handled by caller
        if (pattern === '') return false;

        // Detect anchored end-of-string
        let anchored = false;
        let p = pattern;
        if (p.endsWith('$')) {
            anchored = true;
            p = p.slice(0, -1);
        }

        // BUG-RC-Regex-Question-Mark (D.2 audit, 2026-05-09):
        // Pre-fix the escape char class was missing `?`. A robots.txt
        // pattern with a literal `?` (e.g. `Disallow: /admin?`) became
        // regex `^/admin?` where `?` is a quantifier (zero-or-one) → the
        // `n` becomes optional → matches `/admi/users` too → over-blocks.
        // Post-fix: `?` added to the escape class. `*` stays out (it's
        // re-converted to wildcard `.*` by the following replace).
        // Test: tests/run-robots-compliance-node.mjs (Test 3).
        const escaped = p.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
        const regexPattern = escaped.replace(/\*/g, '.*');

        try {
            const regex = new RegExp(`^${regexPattern}${anchored ? '$' : ''}`);
            return regex.test(path);
        } catch {
            return path.startsWith(pattern.replace(/\*/g, ''));
        }
    }

    /**
     * Public helper: get the Crawl-delay (seconds) for a URL, or 0 if none.
     * Caller passes session headers so the matching UA section is selected.
     */
    async getCrawlDelay(url, options = {}) {
        const userAgent = this._extractUserAgent(options.headers);
        try {
            const urlObj = new URL(url);
            const rules = await this._getRules(urlObj.hostname, urlObj.protocol, userAgent);
            if (!rules) return 0;
            const matched = this._matchUserAgent(rules, userAgent) || rules['*'];
            return (matched && matched.crawlDelay) || 0;
        } catch {
            return 0;
        }
    }

    /**
     * Test seam: clear the in-memory cache.
     */
    clearCache() {
        this.cache.clear();
    }
}

// MV3 SW EVICTION POLICY (B11-6 cluster triage 2026-05-10): SAFE-BY-SEMANTICS.
// The instance holds a per-domain cache of parsed robots.txt rules with a
// 24h TTL. Loss at SW eviction means cache resets → next isAllowed(url) call
// re-fetches and re-parses robots.txt from origin servers (5s fetch timeout).
// Adds latency on wake but maintains compliance correctness. Cache is a
// performance optimization, not a state machine.
// SW-EVICTION-SAFE: cache rebuilt lazily; no compliance correctness loss.
export const robotsCompliance = new RobotsCompliance();
export default robotsCompliance;

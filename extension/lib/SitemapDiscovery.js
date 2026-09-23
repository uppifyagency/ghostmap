/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

import { CONFIG } from './config.js';
import { logger } from './utils.js';


/**
 * Sitemap Discovery Service
 * Finds and parses sitemaps to discover hidden contact pages
 */
export class SitemapDiscovery {
    constructor() {
        this.commonPaths = [
            '/sitemap.xml',
            '/sitemap_index.xml',
            '/wp-sitemap.xml',           // WordPress
            '/sitemap.php',
            '/sitemap.txt',
            '/sitemap1.xml',
            '/post-sitemap.xml',         // WordPress posts
            '/page-sitemap.xml',         // WordPress pages
            '/sitemaps.xml',
            '/sitemap-index.xml',
            '/sitemap/sitemap.xml',
            '/sitemap/index.xml'
        ];

        // Keywords to look for in sitemap URLs (same as parser.js)
        this.keywords = [
            // English
            'contact', 'about', 'touch', 'support', 'team', 'help', 'inquiry', 'career', 'job',
            // Italian
            'contatti', 'contatto', 'chi-siamo', 'chisiamo', 'storia', 'azienda', 'scrivici',
            // Spanish
            'contacto', 'nosotros', 'quienes', 'historia', 'equipo',
            // French
            'contact', 'propos', 'histoire', 'equipe',
            // German
            'kontakt', 'uber', 'ueber', 'impressum', 'team'
        ];
    }

    /**
     * Discover relevant URLs from sitemaps
     * AUDIT FIX #11: Limit results to prevent memory issues
     * @param {string} baseUrl - The website base URL
     * @param {number} maxPages - Maximum pages to return (default 50)
     * @returns {Promise<string[]>} - List of discovered relevant URLs
     */
    async discover(baseUrl, maxPages = 50) {
        try {
            const sitemapUrl = await this.detectSitemap(baseUrl);
            if (!sitemapUrl) {
                return [];
            }

            logger.info(`🗺️ Found sitemap at: ${sitemapUrl}`);
            const urls = await this.fetchAndParse(sitemapUrl);

            const relevantUrls = this.filterRelevantUrls(urls);

            // AUDIT FIX #11: Cap results to prevent memory exhaustion
            const cappedUrls = relevantUrls.slice(0, maxPages);

            if (cappedUrls.length > 0) {
                logger.info(`🗺️ Found ${cappedUrls.length} relevant pages in sitemap (capped at ${maxPages})`);
            }

            return cappedUrls;

        } catch (error) {
            logger.warn(`Sitemap discovery failed for ${baseUrl}:`, error.message);
            return [];
        }
    }


    /**
     * Try to find the sitemap URL
     * Uses aggressive timeout and error handling to never block the scraping process
     */
    async detectSitemap(baseUrl) {
        // 1. Check robots.txt first (most reliable)
        try {
            const robotsUrl = new URL('/robots.txt', baseUrl).toString();
            const response = await this.fetchWithTimeout(robotsUrl, 'GET', 3000); // 3s timeout
            if (response.ok) {
                const text = await response.text();
                const match = text.match(/Sitemap:\s*(https?:\/\/[^\s]+)/i);
                if (match && match[1]) {
                    logger.debug(`[SITEMAP] Found in robots.txt: ${match[1]}`);
                    return match[1];
                }
            }
        } catch (e) {
            logger.debug(`[SITEMAP] robots.txt check failed: ${e.message}`);
            // Continue to common paths
        }

        // 2. Check common paths with HEAD requests (fast)
        for (const path of this.commonPaths) {
            try {
                const url = new URL(path, baseUrl).toString();
                const response = await this.fetchWithTimeout(url, 'HEAD', 2000); // 2s timeout
                if (response.ok && response.status === 200) {
                    logger.debug(`[SITEMAP] Found at: ${url}`);
                    return url;
                }
            } catch (e) {
                // Silently continue to next path
                continue;
            }
        }

        logger.debug(`[SITEMAP] No sitemap found for ${baseUrl}`);
        return null;
    }

    /**
     * Fetch and parse sitemap (handles recursion for indices)
     *
     * LIB-16 FIX (2026-05-10): pre-fix `fetchAndParse` followed every
     * <loc> URL from a sitemap-index recursively WITHOUT restricting the
     * sub-sitemap host to the originating domain. An attacker who controls
     * a sitemap discovered during enrichment could craft entries like:
     *   <loc>http://169.254.169.254/latest/meta-data/</loc>  (AWS metadata)
     *   <loc>http://10.0.0.1/admin/</loc>                    (intranet)
     *   <loc>https://victim.com/internal-api</loc>           (cross-origin probe)
     * and the extension's privileged fetch context would issue requests
     * to those URLs. The contents would not be exfiltrated (response is
     * parsed as sitemap XML and discarded if not), but the request itself
     * is enough for an oracle / DoS / cache-poisoning surface.
     *
     * Fix: pin the originating domain on the FIRST call (depth 0) and
     * reject sub-sitemaps whose URL.hostname doesn't match (allow same-
     * hostname OR a subdomain of it). Also reject any non-https? scheme.
     * Same DNS-rebinding caveat as LIB-2 applies; mitigating that
     * requires resolve+pin and is out of scope.
     */
    async fetchAndParse(url, depth = 0, rootHost = null) {
        if (depth > 1) return []; // Limit recursion depth

        // LIB-16: capture the root hostname on entry and validate sub-URLs.
        let parsedUrl;
        try { parsedUrl = new URL(url); }
        catch { logger.warn(`[Sitemap] invalid URL: ${url}`); return []; }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            logger.warn(`[Sitemap] rejected non-http(s) scheme: ${parsedUrl.protocol}`);
            return [];
        }
        if (rootHost === null) {
            rootHost = parsedUrl.hostname.toLowerCase();
        } else {
            const sub = parsedUrl.hostname.toLowerCase();
            const sameOrSub = sub === rootHost || sub.endsWith('.' + rootHost);
            if (!sameOrSub) {
                logger.warn(`[Sitemap] rejected cross-origin sub-sitemap: ${sub} (root: ${rootHost})`);
                return [];
            }
        }

        try {
            const response = await this.fetchWithTimeout(url);
            if (!response.ok) return [];

            const xml = await response.text();

            // Check if it's a sitemap index
            if (xml.includes('<sitemapindex')) {
                const sitemapUrls = this.extractUrls(xml, 'loc');
                const relevantSitemaps = sitemapUrls.filter(u =>
                    u.includes('page') || u.includes('main') || u.includes('sitemap')
                ).slice(0, 3); // Limit to 3 sub-sitemaps to save time

                const results = [];
                for (const subUrl of relevantSitemaps) {
                    // LIB-16: propagate rootHost so the recursion stays
                    // pinned to the origin discovered at depth 0.
                    const subResults = await this.fetchAndParse(subUrl, depth + 1, rootHost);
                    results.push(...subResults);
                }
                return results;
            }

            // It's a regular sitemap
            return this.extractUrls(xml, 'loc');

        } catch (error) {
            logger.warn(`Failed to parse sitemap ${url}:`, error.message);
            return [];
        }
    }

    /**
     * Extract content of specific tags
     * Handles CDATA sections
     * @param {string} xml - XML content
     * @param {string} tagName - Tag name to extract
     * @returns {string[]} Array of URLs
     */
    extractUrls(xml, tagName = 'loc') {
        const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
        const matches = [];
        let match;
        while ((match = regex.exec(xml)) !== null) {
            let content = match[1].trim();
            // Remove CDATA wrapper if present
            content = content.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
            if (content && content.startsWith('http')) {
                matches.push(content);
            }
        }
        return matches;
    }

    /**
     * Filter URLs that match our keywords
     */
    filterRelevantUrls(urls) {
        return urls.filter(url => {
            const lowerUrl = url.toLowerCase();
            return this.keywords.some(keyword => lowerUrl.includes(keyword));
        });
    }

    /**
     * Fetch with timeout
     * @param {string} url - URL to fetch
     * @param {string} method - HTTP method (GET or HEAD)
     * @param {number} timeoutMs - Timeout in milliseconds (default 5000)
     */
    async fetchWithTimeout(url, method = 'GET', timeoutMs = 5000) {
        const controller = new AbortController();
        // OBS-1 (2026-05-17): pass an explicit reason so the AbortError that
        // fetch() throws carries a meaningful `.message` instead of the
        // default "signal is aborted without reason". Name is kept as
        // 'AbortError' to preserve consumers that branch on error.name.
        const timeout = setTimeout(
            () => controller.abort(new DOMException(`sitemap ${method} timeout ${timeoutMs}ms`, 'AbortError')),
            timeoutMs
        );

        // Use rotating realistic User-Agents (same as background worker)
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
        ];
        const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

        try {
            const response = await fetch(url, {
                method,
                signal: controller.signal,
                headers: {
                    'User-Agent': randomUA,
                    'Accept': 'application/xml,text/xml,*/*;q=0.9'
                }
            });
            clearTimeout(timeout);
            return response;
        } catch (error) {
            clearTimeout(timeout);
            throw error;
        }
    }
}

export const sitemapDiscovery = new SitemapDiscovery();

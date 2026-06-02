// ============================================================================
// DIAGNOSTIC: Track script load immediately (before any other code)
// ============================================================================
console.log('[OFFSCREEN-DIAG] parser.js EXECUTION STARTED at', new Date().toISOString());
console.log('[OFFSCREEN-DIAG] Document URL:', typeof document !== 'undefined' ? document.location.href : 'N/A');
console.log('[OFFSCREEN-DIAG] Chrome runtime available:', typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined');

/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - HTML Parser for Offscreen Document
 * Config values imported from lib/config.js (single source of truth)
 */

import { CONFIG as AuthoritativeConfig } from '../lib/config.js';
import { extractPartitaIva } from '../lib/partitaIva.js';

// ============================================================================
// CONFIG REFERENCES (imported from lib/config.js - single source of truth)
// ============================================================================
const EMAIL_BLACKLIST = AuthoritativeConfig.extraction.email.blacklist;
const VALID_TLDS = AuthoritativeConfig.extraction.email.validTLDs;
const PARSER_CONFIG = {
    extraction: {
        social: {
            platforms: AuthoritativeConfig.extraction.social.platforms
        }
    }
};

// Convenience alias used internally
const CONFIG = PARSER_CONFIG;

// Export for testing
export { EMAIL_BLACKLIST, VALID_TLDS, PARSER_CONFIG };

// ============================================================================
// INLINE LOGGER WITH LOG LEVEL FILTERING
// ============================================================================
// OFF-003 FIX: Log level filtering to reduce console noise in production
// Levels: 'debug' | 'info' | 'warn' | 'error' (default: 'warn' for production)
// ============================================================================
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLogLevel = 'warn'; // Production default - reduces console spam

const logger = {
    setLevel: (level) => {
        if (LOG_LEVELS[level] !== undefined) {
            currentLogLevel = level;
            console.log(`[Ghost Map] Log level set to: ${level}`);
        }
    },
    debug: (...args) => LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.debug && console.log('[Ghost Map][DEBUG]', ...args),
    info: (...args) => LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.info && console.log('[Ghost Map]', ...args),
    warn: (...args) => LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.warn && console.warn('[Ghost Map]', ...args),
    error: (...args) => console.error('[Ghost Map][ERROR]', ...args) // Always log errors
};

// ============================================================================
// MESSAGE LISTENER - REGISTERED IMMEDIATELY
// ============================================================================
// DIAGNOSTIC: Log listener registration
console.log('[OFFSCREEN-DIAG] 🔵 Registering chrome.runtime.onMessage listener...');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // DIAGNOSTIC: Log ALL incoming messages to this context
    console.log('[OFFSCREEN-DIAG] 📨 Message received:', JSON.stringify({
        action: message.action,
        target: message.target,
        sender: sender?.id || 'unknown',
        hasPayload: !!message.payload
    }));

    // B7-4 fix: validate sender extension ID. The offscreen document only
    // accepts messages from its own extension (any other origin would not
    // be able to reach this listener under MV3 anyway, but the explicit
    // check is defense-in-depth — protects against unexpected cross-context
    // calls if the manifest is later widened).
    const ourId = chrome.runtime.id;
    if (sender?.id && sender.id !== ourId) {
        console.warn('[OFFSCREEN] Rejected message from foreign sender:', sender.id);
        return false;
    }

    // CRITICAL: Only respond to messages explicitly targeted to offscreen
    if (message.action === 'parse_html' && message.target === 'offscreen') {
        logger.debug(`[OFFSCREEN] Received parse_html request for: ${message.payload?.url}`);

        const requestId = message.requestId || null;

        // Handle async parsing properly
        (async () => {
            try {
                const { html, url } = message.payload;

                // OFF-006 FIX: Add timing metrics for parsing performance
                const parseStart = performance.now();
                const result = parseHTML(html, url);
                const parseTime = performance.now() - parseStart;

                // Log timing if debug enabled (respects OFF-003 log level filtering)
                logger.debug(`[OFFSCREEN] Parsed ${url} in ${parseTime.toFixed(2)}ms - ${result.emails.length} emails found`);

                const response = {
                    success: true,
                    data: result,
                    emails: result.emails,
                    source: 'offscreen',
                    requestId: requestId,
                    parseTimeMs: parseTime // Include timing in response for metrics
                };

                logger.debug(`[OFFSCREEN] Sending response for ${url}: ${result.emails.length} emails`);
                sendResponse(response);
            } catch (error) {
                logger.error('[OFFSCREEN] Parse error:', error);
                sendResponse({
                    success: false,
                    error: error.message,
                    emails: [],
                    socialLinks: {},
                    source: 'offscreen',
                    requestId: requestId
                });
            }
        })();

        return true; // Keep channel open for async response
    } else if (message.action === 'ping' && message.target === 'offscreen') {
        // DIAGNOSTIC: Log ping handling
        console.log('[OFFSCREEN-DIAG] 🏓 PING received, sending PONG response');
        sendResponse({ status: 'alive', timestamp: Date.now(), source: 'offscreen' });
        return false; // Synchronous response
    }

    return false;
});

console.log('[OFFSCREEN-DIAG] ✅ Message listener REGISTERED successfully');

// ============================================================================
// PARSING FUNCTIONS
// ============================================================================

// BLOCK-6 FIX (MED-021): Singleton DOMParser for better performance
const domParser = new DOMParser();

function parseHTML(html, url) {
    // ═════════════════════════════════════════════════════════════════════════
    // OFF-004 FIX: Validate HTML size before parsing to prevent memory issues
    // Large pages (>5MB) can crash the offscreen document's DOM parser
    // ═════════════════════════════════════════════════════════════════════════
    // 
    // ═════════════════════════════════════════════════════════════════════════
    // M3-002 ARCHITECTURE NOTE: Timeout Protection
    // ─────────────────────────────────────────────────────────────────────────
    // This synchronous parser is protected by TWO timeout mechanisms:
    // 
    // 1. SIZE LIMIT (below): Rejects HTML > 5MB before parsing starts
    // 
    // 2. TIME LIMIT: 15-second timeout at CALLER level
    //    Location: background/index.js → parseHTMLInOffscreen()
    //    Implementation: Promise.race([responsePromise, timeoutPromise])
    //    On timeout: Falls back to parseHTMLDirect() in background context
    // 
    // Why timeout is at caller, not here:
    // - JavaScript is single-threaded; synchronous ops can't be interrupted
    // - DOMParser.parseFromString() blocks until complete
    // - Only async message passing can be "raced" against a timeout
    // ═════════════════════════════════════════════════════════════════════════
    const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5MB limit
    if (html && html.length > MAX_HTML_SIZE) {
        const sizeKB = Math.round(html.length / 1024);
        const sizeMB = (html.length / 1024 / 1024).toFixed(2);
        logger.warn(`[SECURITY] Rejecting oversized HTML: ${sizeMB}MB (${sizeKB}KB) from ${url}`);
        throw new Error(`HTML too large: ${sizeMB}MB exceeds ${MAX_HTML_SIZE / 1024 / 1024}MB limit`);
    }

    const doc = domParser.parseFromString(html, 'text/html');

    const emails = extractEmails(doc);
    const socialLinks = extractSocialLinks(doc);
    const contactForm = findContactForm(doc);
    const contactLinks = extractContactLinks(doc, url);
    const italianTaxCodes = extractItalianTaxCodes(doc);

    logger.info(`Parsed ${url}: Found ${emails.length} emails`);
    if (italianTaxCodes.partitaIva || italianTaxCodes.codiceFiscale) {
        logger.info(`[ITALIAN B2B] Found P.IVA: ${italianTaxCodes.partitaIva || 'N/A'}, C.F.: ${italianTaxCodes.codiceFiscale || 'N/A'}`);
    }

    return {
        url,
        emails,
        socialLinks,
        contactForm,
        contactLinks,
        italianTaxCodes,
        title: doc.title || ''
    };
}

/**
 * Clean TLD by removing garbage suffix after valid TLD
 * @param {string} email - Raw email
 * @returns {string} - Cleaned email
 */
/**
 * Clean email by removing concatenated URLs, P.IVA, and other garbage
 * CRITICAL FIX (18 Dec 2025 - NSA Level): Scan ALL segments LEFT-TO-RIGHT
 * Examples:
 *   agenzia@hotmail.comwww.agenzia-esempio.com → agenzia@hotmail.com
 *   info@dove.itp.iva → info@dove.it
 */
function cleanTLD(email) {
    const parts = email.split('@');
    if (parts.length !== 2) return email;

    const [localPart, domainPart] = parts;
    const domainSegments = domainPart.split('.');
    if (domainSegments.length < 2) return email;

    // CO-11 FIX (2026-05-10) + OF-1 FIX (2026-05-27): pre-CO-11 the function
    // scanned left-to-right and trimmed at the FIRST valid-TLD segment. That
    // correctly cleaned garbage-attached cases like
    // "hotmail.comwww.agenzia-esempio.com" → "hotmail.com" BUT incorrectly
    // truncated legitimate subdomain emails such as
    //   info@app.dev.example.com   → info@app.dev          (3 segments lost)
    //   foo@webmail.pro.brand.it   → foo@webmail.pro       (lost)
    //   admin@info.shop.brand.com  → admin@info.shop       (lost)
    // because labels like .app/.dev/.pro/.shop/.tech/.info/.name/.mobi/.site
    // are also valid TLDs that can appear as subdomain labels.
    //
    // CO-11 introduced a guard that prevented the trim when the LAST segment
    // was a known TLD (treat as subdomain chain). However, that guard was
    // incomplete: when the last segment was an UNCOMMON TLD not in
    // VALID_TLDS (e.g. .xyz, .ai, .custom), the guard flipped permissive and
    // the original corruption returned:
    //   ceo@tech.app.foo.xyz       → ceo@tech.app          (OF-1 bug)
    //
    // OF-1 FIX: drop the exact-match trim entirely. Both branches of the
    // guard were wrong — if the last segment is a known TLD the email is
    // well-formed and must be preserved (CO-11 intent), and if it is not
    // we cannot tell apart "garbage subdomain with TLD-mid" from "uncommon
    // TLD at end", so the conservative choice is also to preserve. True
    // garbage like "comwww" is still caught by the starts-with branch
    // below, which does not depend on last-segment shape.
    for (let i = 1; i < domainSegments.length; i++) {
        const segment = domainSegments[i].toLowerCase();

        // Exact valid TLD match → always preserve (see OF-1 FIX comment above).
        if (VALID_TLDS.includes(segment)) {
            return email;
        }

        // Starts-with-TLD garbage pattern (e.g. "comwww" → "com").
        // Unchanged from pre-fix — this case is unambiguous garbage and
        // safely identifies trailing junk regardless of last-segment shape.
        for (const validTLD of VALID_TLDS) {
            if (segment.startsWith(validTLD) && segment.length > validTLD.length) {
                const cleanSegments = domainSegments.slice(0, i + 1);
                cleanSegments[i] = validTLD;
                return `${localPart}@${cleanSegments.join('.')}`;
            }
        }
    }

    return email;
}

/**
 * R7 (TIER A): decode Cloudflare email-protection hex payload.
 * First byte = XOR key; remaining bytes = key XOR plaintext.
 * Returns '' for any malformed input.
 */
function decodeCloudflareHex(hex) {
    if (typeof hex !== 'string' || hex.length < 4 || hex.length % 2 !== 0) return '';
    if (hex.length > 512) return '';
    if (!/^[0-9a-fA-F]+$/.test(hex)) return '';
    const key = parseInt(hex.slice(0, 2), 16);
    if (Number.isNaN(key)) return '';
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
        const byte = parseInt(hex.slice(i, i + 2), 16);
        if (Number.isNaN(byte)) return '';
        out += String.fromCharCode(byte ^ key);
    }
    if (!out.includes('@') || out.length > 254) return '';
    return out;
}

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
 * background/index.js:_stripIdentifierPrefix.
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

function extractEmails(doc) {
    const emails = new Set();
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

    // Get text content
    let textContent = (doc.body?.textContent || '')
        .replace(/\s*\[at\]\s*/gi, '@')
        .replace(/\s*\(at\)\s*/gi, '@')
        .replace(/\s*\[dot\]\s*/gi, '.')
        .replace(/\s*\(dot\)\s*/gi, '.');

    // Also check href attributes for mailto: links
    const mailtoLinks = doc.querySelectorAll('a[href^="mailto:"]');
    mailtoLinks.forEach(link => {
        const href = link.getAttribute('href') || '';
        const emailMatch = href.replace('mailto:', '').split('?')[0];
        if (emailMatch && emailMatch.includes('@')) {
            textContent += ' ' + emailMatch;
        }
    });

    // R7: append Cloudflare-decoded emails to textContent so they flow
    // through the existing dedup/blacklist/cleanTLD pipeline below.
    try {
        doc.querySelectorAll('[data-cfemail]').forEach(el => {
            const decoded = decodeCloudflareHex(el.getAttribute('data-cfemail') || '');
            if (decoded) textContent += ' ' + decoded;
        });
        doc.querySelectorAll('a[href*="cdn-cgi/l/email-protection"]').forEach(link => {
            const href = link.getAttribute('href') || '';
            const idx = href.indexOf('#');
            if (idx >= 0) {
                const decoded = decodeCloudflareHex(href.slice(idx + 1));
                if (decoded) textContent += ' ' + decoded;
            }
        });
    } catch { /* DOM may be limited in certain contexts; safe to ignore */ }

    const matches = textContent.match(emailRegex) || [];

    matches.forEach(email => {
        let clean = email.toLowerCase().trim();

        // BUG-4 / OBS-3 backport: strip Italian CF (16-char) or P.IVA
        // (11-digit) prefix that DOM-text concatenation may have fused
        // into the local-part. Must run BEFORE phone-prefix cleanup
        // because phone cleanup is leading-digit only and would skip
        // CF (which starts with letters).
        clean = _stripIdentifierPrefix(clean);

        // Remove unicode escape prefixes (u003e = >)
        clean = clean.replace(/^u003[ce]/gi, '');

        // Remove URL-encoded space prefix
        clean = clean.replace(/^%20/, '');

        // Remove phone number prefixes (02-66106053info@ -> info@)
        clean = clean.replace(/^[\d.\-]{1,15}(?=[a-zA-Z])/, '');

        // Remove text label prefixes
        clean = clean.replace(/^(information|informazioni|italia|italy)(?=[a-z])/i, '');

        // Remove leading dots
        clean = clean.replace(/^\.+/, '');

        // CRITICAL FIX-007: Process multi-extension BEFORE cleanTLD!
        // The emailRegex can over-capture text after the TLD (e.g., "gmail.comContattaci")
        // This regex extracts just the valid email by matching up to a known TLD
        // TLDs are ordered by LENGTH DESC to prevent .com → .co truncation!
        const multiExtMatch = clean.match(/^(.+@[a-zA-Z0-9.-]+\.(?:info|name|mobi|tech|shop|site|online|store|com|org|net|edu|gov|biz|pro|app|dev|it|de|fr|es|nl|ch|at|be|uk|eu|us|ca|io|co|me|tv))(?:[^a-zA-Z].*)?$/i);
        if (multiExtMatch && multiExtMatch[1]) {
            clean = multiExtMatch[1];
        }

        // Clean corrupted TLD suffix (backup for edge cases)
        clean = cleanTLD(clean);

        // Skip image files
        if (clean.endsWith('.png') || clean.endsWith('.jpg') || clean.endsWith('.gif')) {
            return;
        }

        // Validate local part
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

        // Check blacklist
        const isBlacklisted = EMAIL_BLACKLIST.some(d =>
            domain === d || domain.endsWith('.' + d)
        );

        if (!isBlacklisted && clean.includes('@')) {
            emails.add(clean);
        }
    });

    return Array.from(emails);
}

function extractSocialLinks(doc) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    // BLOCK-9 FIX (MED-011): Store arrays of ALL social links, not just first
    // M3-HOTFIX: Added tiktok to match CONFIG.extraction.social.platforms
    const social = {
        facebook: [],
        instagram: [],
        twitter: [],
        linkedin: [],
        youtube: [],
        tiktok: []
    };

    links.forEach(link => {
        const href = link.href.toLowerCase();

        Object.entries(CONFIG.extraction.social.platforms).forEach(([platform, domains]) => {
            // M3-HOTFIX: Guard against platforms not in social object
            if (!social[platform]) {
                social[platform] = [];
            }
            domains.forEach(domain => {
                if (href.includes(domain)) {
                    // Add to array, avoid duplicates
                    if (!social[platform].includes(link.href)) {
                        social[platform].push(link.href);
                    }
                }
            });
        });
    });

    // Convert empty arrays to null for backward compatibility
    Object.keys(social).forEach(platform => {
        if (social[platform].length === 0) {
            social[platform] = null;
        } else if (social[platform].length === 1) {
            // Keep single value as string for backward compatibility
            social[platform] = social[platform][0];
        }
        // Arrays with multiple values remain as arrays
    });

    return social;
}

function findContactForm(doc) {
    const forms = doc.querySelectorAll('form');

    for (const form of forms) {
        const formText = form.textContent.toLowerCase();
        const formAction = (form.getAttribute('action') || '').toLowerCase();
        const formId = (form.getAttribute('id') || '').toLowerCase();
        const formClass = (form.getAttribute('class') || '').toLowerCase();

        const contactKeywords = ['contact', 'email', 'message', 'inquiry', 'touch'];
        const isContactForm = contactKeywords.some(keyword =>
            formText.includes(keyword) ||
            formAction.includes(keyword) ||
            formId.includes(keyword) ||
            formClass.includes(keyword)
        );

        if (isContactForm) {
            const emailInput = form.querySelector('input[type="email"], input[name*="email"]');
            if (emailInput) {
                return {
                    found: true,
                    action: form.getAttribute('action'),
                    method: form.getAttribute('method') || 'post'
                };
            }
        }
    }

    return { found: false };
}

function extractContactLinks(doc, baseUrl) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const contactLinks = new Set();

    const keywords = [
        'contact', 'about', 'touch', 'support', 'team', 'help', 'inquiry', 'career', 'job',
        'contatti', 'contatto', 'chi siamo', 'chisiamo', 'storia', 'azienda', 'scrivici',
        'contacto', 'nosotros', 'quienes', 'historia', 'equipo',
        'propos', 'histoire', 'equipe',
        'kontakt', 'uber', 'ueber', 'impressum'
    ];

    try {
        const baseObj = new URL(baseUrl);
        const hostname = baseObj.hostname;

        links.forEach(link => {
            const rawHref = link.getAttribute('href');
            if (!rawHref || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
                return;
            }

            const text = link.textContent.toLowerCase();

            try {
                const absoluteUrl = new URL(rawHref, baseUrl);
                const isInternal = absoluteUrl.hostname === hostname || absoluteUrl.hostname.endsWith('.' + hostname);

                if (isInternal) {
                    const urlLower = absoluteUrl.href.toLowerCase();
                    if (keywords.some(k => text.includes(k) || urlLower.includes(k))) {
                        contactLinks.add(absoluteUrl.toString());
                    }
                }
            } catch (e) {
                // Invalid URL - skip
            }
        });
    } catch (e) {
        logger.warn('Error extracting contact links:', e);
    }

    return Array.from(contactLinks);
}

// ============================================================================
// ITALIAN TAX CODES EXTRACTION
// ============================================================================

const CODICE_FISCALE_PATTERN = /(?:C\.?\s*F\.?|Codice\s*Fiscale|Fiscal\s*Code)[:\s]*([A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z])\b/gi;

function extractItalianTaxCodes(doc) {
    const result = {
        partitaIva: null,
        codiceFiscale: null
    };

    const textContent = doc.body?.textContent || '';
    const metaContent = Array.from(doc.querySelectorAll('meta[content]'))
        .map(m => m.getAttribute('content'))
        .join(' ');

    const fullText = textContent + ' ' + metaContent;

    // Extract Partita IVA — shared SSOT (lib/partitaIva.js): checksum-validated,
    // handles composite labels like "P.IVA/C.F. NNN" / "Cod.Fisc./Part.IVA/... NNN".
    result.partitaIva = extractPartitaIva(fullText);
    if (result.partitaIva) logger.info(`[FALLBACK] ✓ Found P.IVA: ${result.partitaIva}`);

    // Extract Codice Fiscale
    CODICE_FISCALE_PATTERN.lastIndex = 0;
    const cfMatch = CODICE_FISCALE_PATTERN.exec(fullText.toUpperCase());
    if (cfMatch && cfMatch[1]) {
        result.codiceFiscale = cfMatch[1].toUpperCase();
    }

    return result;
}

// ============================================================================
// INITIALIZATION
// ============================================================================
logger.info('[OFFSCREEN] Standalone parser initialized successfully');

// DIAGNOSTIC: Final confirmation that script fully loaded
console.log('[OFFSCREEN-DIAG] ✅✅✅ parser.js FULLY LOADED AND READY at', new Date().toISOString());

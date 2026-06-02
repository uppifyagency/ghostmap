/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Email Extractor
 * Simplified and robust email extraction using user-provided logic
 */

import { logger } from './utils.js';
import { CONFIG } from './config.js';

export class EmailExtractor {
    constructor(config = {}) {
        this.config = config;
        // IMPROVED: Stricter regex that requires boundary before email
        // This prevents capturing "text1965info@" and instead finds clean boundaries
        // Matches: start, whitespace, (, <, ", ', :, ; before email
        this.emailRegex = /(?:^|[\s(<"':;,\[\]])([a-zA-Z][a-zA-Z0-9._%+-]{0,63}@[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,})/g;

        // Simpler fallback regex for additional matching
        this.simpleEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    }

    /**
     * OBS-3 (2026-05-17): strip Italian identifier prefixes that DOM-text
     * concatenation can fuse with email local-parts.
     *
     * OBSERVED LEAKS in production scrapes:
     *   - "RSSMRA80A01H501Uinfo@studio-esempio.it"  (CF + info — architetti)
     *   - "info-rrhh@hotel-esempio.com"                     (other-prefix + email — hotel)
     *
     * The DOM contains adjacent elements like:
     *   <dd>RSSMRA80A01H501U</dd><dd>info@studio-esempio.it</dd>
     * Body.innerText collapses to "RSSMRA80A01H501Uinfo@studio-esempio.it".
     * Both `^[a-zA-Z]...` (strict, anchored at start-of-text) and the simple
     * fallback regex match the whole prefix.
     *
     * Heuristics applied (in order):
     *   1. Italian Codice Fiscale: 16 chars [A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]
     *      at start of local-part → strip those 16 chars.
     *   2. Italian P.IVA: 11 consecutive digits at start → strip them.
     *
     * Trade-offs (steelman):
     *   - Legit `BNCLRA85M41H501Y@x.it` (CF as full local-part) → "@x.it" →
     *     fails validation. Acceptable: a real address shaped exactly like a
     *     CF is statistically negligible.
     *   - Legit `01234567890@x.it` (11-digit local) → invalid post-strip.
     *     Acceptable for same reason.
     *   - Phone number with 11 digits + email (`33912345678info@x.it`) →
     *     stripped to `info@x.it`. Italian phone numbers are typically 9-10
     *     digits without country code, 12 with; 11-digit collisions exist
     *     but the resulting email is still useful.
     *
     * FOLLOW-UP TODO: pure-Node test mocking 6 input/output pairs (CF+info,
     * P.IVA+info, CF puro, P.IVA puro, phone-11+info, no-prefix legit) so
     * any regression of this heuristic surfaces fast.
     *
     * @param {string} email
     * @returns {string} email with identifier prefix stripped, or original if no match
     * @private
     */
    _stripIdentifierPrefix(email) {
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
     * Extract emails from document
     * IMPROVED: Better extraction from multiple sources
     * @param {Document} doc - DOM document
     * @returns {Array<string>} - Clean email list
     */
    extractClean(doc) {
        try {
            // PATCH #6: FAST PATH - Try regex on raw HTML first (skips DOM parsing)
            const rawHTML = doc.documentElement?.outerHTML || doc.body?.innerHTML || '';

            if (rawHTML) {
                // Quick mailto extraction (fastest - Business emails often in mailto links)
                const mailtoMatches = rawHTML.match(/mailto:([^"'\s?&]+)/gi);
                if (mailtoMatches && mailtoMatches.length > 0) {
                    const emails = mailtoMatches
                        .map(m => m.replace(/^mailto:/i, '').trim())
                        .filter(e => e && e.includes('@') && this.isValidEmail(e));

                    if (emails.length > 0) {
                        logger.debug(`[FastPath] Found ${emails.length} emails via mailto`);
                        return [...new Set(emails)];
                    }
                }

                // Quick regex scan on HTML (fast - catches most visible emails)
                const quickMatches = rawHTML.match(this.simpleEmailRegex);
                if (quickMatches && quickMatches.length > 0 && quickMatches.length <= 20) {
                    // Only use if reasonable number (avoid pages with 100s of fake emails)
                    // OBS-3: strip CF / P.IVA prefix BEFORE validation so leaks
                    // like "RSSMRA80A01H501Uinfo@x.it" collapse to "info@x.it".
                    const emails = quickMatches
                        .map(e => this._stripIdentifierPrefix(e))
                        .filter(e => e && this.isValidEmail(e))
                        .slice(0, 5); // Limit to first 5 valid

                    if (emails.length > 0) {
                        logger.debug(`[FastPath] Found ${emails.length} emails via regex`);
                        return [...new Set(emails)];
                    }
                }
            }

            // SLOW PATH: Full DOM extraction (only if fast path found nothing)
            logger.debug(`[SlowPath] Using full DOM extraction`);

            const body = doc.body || doc;
            const textContent = body.innerText || body.textContent || '';

            logger.debug(`[EmailExtractor] Starting extraction on document length: ${textContent.length}`);

            // 1. Extract using strict regex from visible text
            const matches = [];
            let match;

            // Use strict regex that captures group 1 (the actual email)
            const strictRegex = /(?:^|[\s(<"':;,\[\]])([a-zA-Z][a-zA-Z0-9._%+-]{0,63}@[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,})/g;
            while ((match = strictRegex.exec(textContent)) !== null) {
                if (match[1]) {
                    // OBS-3: strip Italian identifier prefix from DOM-fused matches.
                    matches.push(this._stripIdentifierPrefix(match[1]));
                }
            }

            logger.debug(`[EmailExtractor] Strict regex found ${matches.length} matches from text`);

            // Also try simple regex for emails that might be at line start
            const simpleMatches = textContent.match(this.simpleEmailRegex) || [];
            simpleMatches.forEach(m => {
                // OBS-3: same prefix-strip pass before dedupe.
                const cleaned = this._stripIdentifierPrefix(m);
                if (!matches.includes(cleaned)) {
                    matches.push(cleaned);
                }
            });
            logger.debug(`[EmailExtractor] Total regex matches: ${matches.length}`);

            // 1b. Extract from mailto links (Crucial for "Email Us" buttons)
            if (doc.querySelectorAll) {
                const mailtoLinks = doc.querySelectorAll('a[href^="mailto:"]');
                mailtoLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    if (href) {
                        const email = href.replace(/^mailto:/i, '').split('?')[0].split('&')[0];
                        if (email && email.includes('@')) {
                            matches.push(email);
                            logger.debug(`[EmailExtractor] Found mailto: ${email}`);
                        }
                    }
                });
            }

            // 1c. Extract from data attributes (common obfuscation)
            if (doc.querySelectorAll) {
                const elementsWithData = doc.querySelectorAll('[data-email], [data-mail], [data-contact]');
                elementsWithData.forEach(el => {
                    ['data-email', 'data-mail', 'data-contact'].forEach(attr => {
                        const value = el.getAttribute(attr);
                        if (value && value.includes('@')) {
                            matches.push(value);
                            logger.debug(`[EmailExtractor] Found in ${attr}: ${value}`);
                        }
                    });
                });
            }

            // 1c-bis. R7 (TIER A): Cloudflare email-protection decoding.
            // Cloudflare wraps emails as:
            //   <a href="/cdn-cgi/l/email-protection#hex" class="__cf_email__"
            //      data-cfemail="hex">[email&#160;protected]</a>
            // The hex is XOR-encoded; the first byte is the key.
            const cfEmails = this.decodeCloudflareEmails(doc);
            if (cfEmails.length > 0) {
                cfEmails.forEach(e => matches.push(e));
                logger.debug(`[EmailExtractor] Decoded ${cfEmails.length} Cloudflare-protected emails`);
            }

            // 1d. Extract from href with encoded emails
            if (doc.querySelectorAll) {
                const allLinks = doc.querySelectorAll('a[href]');
                allLinks.forEach(link => {
                    const href = link.getAttribute('href') || '';
                    // Check for URL-encoded mailto
                    if (href.includes('%40')) { // URL-encoded @
                        const decoded = decodeURIComponent(href);
                        const emailMatch = decoded.match(this.emailRegex);
                        if (emailMatch) {
                            emailMatch.forEach(e => matches.push(e));
                        }
                    }
                });
            }

            // 1e. Extract from HTML source (catches emails in comments, scripts, hidden elements)
            const htmlSource = doc.documentElement?.outerHTML || doc.body?.innerHTML || '';
            const htmlMatches = htmlSource.match(this.emailRegex) || [];
            htmlMatches.forEach(email => {
                // Only add if looks like real email (not from CSS/JS)
                if (!email.includes('.js') && !email.includes('.css') &&
                    !email.includes('webpack') && !email.includes('node_modules')) {
                    matches.push(email);
                }
            });
            logger.debug(`[EmailExtractor] Found ${htmlMatches.length} potential emails in HTML source`);

            // 1f. Handle common obfuscation patterns in text
            const deobfuscatedText = this.deobfuscateText(textContent);
            if (deobfuscatedText !== textContent) {
                const deobfuscatedMatches = deobfuscatedText.match(this.emailRegex) || [];
                deobfuscatedMatches.forEach(e => matches.push(e));
                logger.debug(`[EmailExtractor] Found ${deobfuscatedMatches.length} emails after deobfuscation`);
            }

            // 2. Deduplicate and Clean with normalization (BUG FIX #5)
            const uniqueEmails = new Set();
            const normalizedMap = new Map(); // normalized -> original email
            let filteredCount = 0;

            matches.forEach(email => {
                // BUG FIX #2: Strip leading/trailing punctuation first
                // FIX: Also remove backslash, newlines, and invisible characters from HTML parsing
                let cleanEmail = email.trim();
                if (cleanEmail) {
                    // Remove invisible characters and common artifacts
                    cleanEmail = cleanEmail.replace(/[\r\n\t\f\v\u00A0\u200B-\u200D\uFEFF]/g, '');
                    cleanEmail = cleanEmail.replace(/^["':;,\[\]<>()\\]+/, '').trim();
                    cleanEmail = cleanEmail.replace(/["':;,\[\]<>()\\]+$/, '').trim();
                    // Final safety: remove any remaining backslashes
                    cleanEmail = cleanEmail.replace(/\\/g, '');
                }

                // Skip if empty after cleaning or no @ symbol
                if (!cleanEmail || !cleanEmail.includes('@')) {
                    filteredCount++;
                    return;
                }

                let normalized = cleanEmail.toLowerCase();

                // STEP 1: Clean prefix artifacts (mailto:, email:, numbers, etc.)
                normalized = this.cleanEmailPrefix(normalized);

                // STEP 2: Clean corrupted TLDs
                normalized = this.cleanTLD(normalized);

                // STEP 3: Create normalized key for Gmail-style deduplication
                // Gmail ignores dots in local part: i.l.grappolo = ilgrappolo
                const [localPart, domain] = normalized.split('@');
                if (!localPart || !domain) {
                    filteredCount++;
                    return;
                }
                const normalizedKey = localPart.replace(/\./g, '') + '@' + domain;

                // STEP 4: Check if already exists (normalized)
                if (normalizedMap.has(normalizedKey)) {
                    logger.debug(`[EmailExtractor] DUPLICATE (normalized): ${normalized} ≈ ${normalizedMap.get(normalizedKey)}`);
                    filteredCount++;
                    return;
                }

                // STEP 5: Validate
                if (this.isValidEmail(normalized)) {
                    uniqueEmails.add(normalized);
                    normalizedMap.set(normalizedKey, normalized);
                } else {
                    filteredCount++;
                    logger.debug(`[EmailExtractor] Filtered invalid: ${normalized}`);
                }
            });

            const results = Array.from(uniqueEmails);
            logger.info(`[EmailExtractor] Result: ${results.length} unique emails (Filtered ${filteredCount} invalid/duplicates)`);

            if (results.length > 0) {
                logger.info(`[EmailExtractor] Emails found: ${results.join(', ')}`);
            }

            return results;

        } catch (error) {
            logger.error('[EmailExtractor] Extraction failed:', error);
            return [];
        }
    }

    /**
     * R7 (TIER A): Decode a single Cloudflare email-protection hex string.
     *
     * Cloudflare's encoding (server-side, see /cdn-cgi/scripts/...):
     *   - The first byte (2 hex chars) is the XOR key.
     *   - Each subsequent byte is `key XOR plaintext_byte`.
     *   - Decoding: char = String.fromCharCode( hex[i] XOR key ) for i ≥ 2.
     *
     * Returns an empty string for malformed inputs (odd length, non-hex chars).
     * Defensive against denial-of-service: bails out at 512 chars (256 ASCII bytes,
     * far more than any legitimate email).
     *
     * @param {string} hex - hex-encoded payload (without leading '#')
     * @returns {string} decoded email or '' if invalid
     */
    decodeCloudflareEmailHex(hex) {
        if (typeof hex !== 'string' || hex.length < 4) return '';
        if (hex.length % 2 !== 0) return '';
        if (hex.length > 512) return ''; // DoS guard
        if (!/^[0-9a-fA-F]+$/.test(hex)) return '';

        const key = parseInt(hex.slice(0, 2), 16);
        if (Number.isNaN(key)) return '';

        let out = '';
        for (let i = 2; i < hex.length; i += 2) {
            const byte = parseInt(hex.slice(i, i + 2), 16);
            if (Number.isNaN(byte)) return '';
            out += String.fromCharCode(byte ^ key);
        }

        // Reject decoded strings that don't look like an email — protects
        // against accidentally decoding a payload that wasn't an email.
        if (!out.includes('@') || out.length > 254) return '';
        return out;
    }

    /**
     * R7: Find every Cloudflare-protected email on the document and return
     * the decoded plaintext list.
     *
     * Two attachment shapes are observed in the wild:
     *   1. data-cfemail="<hex>"          ← most common (any element)
     *   2. href="/cdn-cgi/l/email-protection#<hex>"   ← link form
     *
     * Both are queried; results are de-duplicated by the caller's normal
     * dedup pass.
     *
     * @param {Document} doc
     * @returns {string[]}
     */
    decodeCloudflareEmails(doc) {
        const out = [];
        if (!doc || typeof doc.querySelectorAll !== 'function') return out;

        // Shape 1: data-cfemail attribute
        try {
            const els = doc.querySelectorAll('[data-cfemail]');
            els.forEach(el => {
                const hex = el.getAttribute('data-cfemail');
                if (hex) {
                    const decoded = this.decodeCloudflareEmailHex(hex);
                    if (decoded) out.push(decoded);
                }
            });
        } catch { /* DOM lacks selector support, ignore */ }

        // Shape 2: links to /cdn-cgi/l/email-protection#<hex>
        try {
            const links = doc.querySelectorAll('a[href*="cdn-cgi/l/email-protection"]');
            links.forEach(link => {
                const href = link.getAttribute('href') || '';
                const idx = href.indexOf('#');
                if (idx >= 0) {
                    const hex = href.slice(idx + 1);
                    const decoded = this.decodeCloudflareEmailHex(hex);
                    if (decoded) out.push(decoded);
                }
            });
        } catch { /* ignore */ }

        return out;
    }

    /**
     * BGW-M5 FIX: Deobfuscate common email protection patterns
     * Expanded with modern obfuscation techniques (2024)
     * @param {string} text - Text that might contain obfuscated emails
     * @returns {string} - Text with deobfuscated emails
     */
    deobfuscateText(text) {
        if (!text) return '';

        let result = text;

        // ═══════════════════════════════════════════════════════════════
        // TIER 1: Common bracket/parenthesis substitutions
        // ═══════════════════════════════════════════════════════════════
        const tier1Patterns = [
            { pattern: /\[at\]/gi, replace: '@' },
            { pattern: /\[dot\]/gi, replace: '.' },
            { pattern: /\{at\}/gi, replace: '@' },
            { pattern: /\{dot\}/gi, replace: '.' },
            { pattern: /<at>/gi, replace: '@' },
            { pattern: /<dot>/gi, replace: '.' },
            { pattern: /\(at\)/gi, replace: '@' },
            { pattern: /\(dot\)/gi, replace: '.' },
        ];

        // ═══════════════════════════════════════════════════════════════
        // TIER 2: Double bracket variations (common on Italian sites)
        // ═══════════════════════════════════════════════════════════════
        const tier2Patterns = [
            { pattern: /\[\[at\]\]/gi, replace: '@' },
            { pattern: /\[\[dot\]\]/gi, replace: '.' },
            { pattern: /\(\(at\)\)/gi, replace: '@' },
            { pattern: /\(\(dot\)\)/gi, replace: '.' },
        ];

        // ═══════════════════════════════════════════════════════════════
        // TIER 3: Word boundary patterns (spaces, dashes)
        // ═══════════════════════════════════════════════════════════════
        const tier3Patterns = [
            { pattern: / at /gi, replace: '@' },
            { pattern: / dot /gi, replace: '.' },
            { pattern: / AT /g, replace: '@' },
            { pattern: / DOT /g, replace: '.' },
            { pattern: /-at-/gi, replace: '@' },
            { pattern: /-dot-/gi, replace: '.' },
            { pattern: /_at_/gi, replace: '@' },
            { pattern: /_dot_/gi, replace: '.' },
        ];

        // ═══════════════════════════════════════════════════════════════
        // TIER 4: Italian and Spanish variants
        // ═══════════════════════════════════════════════════════════════
        const tier4Patterns = [
            { pattern: /\[chiocciola\]/gi, replace: '@' },  // Italian "snail"
            { pattern: /\(chiocciola\)/gi, replace: '@' },
            { pattern: /\[punto\]/gi, replace: '.' },       // Italian "dot"
            { pattern: /\(punto\)/gi, replace: '.' },
            { pattern: /\[arroba\]/gi, replace: '@' },      // Spanish "@"
            { pattern: /\(arroba\)/gi, replace: '@' },
        ];


        // ═══════════════════════════════════════════════════════════════
        // TIER 5: Whitespace normalization (safe patterns only)
        // ═══════════════════════════════════════════════════════════════
        // REMOVED: HTML entity decoding (&#64;, &#x40;, etc.) - too aggressive
        // These were extracting spam/tracking emails from HTML source
        const tier5Patterns = [
            { pattern: /\u00A0/g, replace: ' ' },           // nbsp -> space
            { pattern: /\u200B/g, replace: '' },            // Zero-width space
        ];

        // ═══════════════════════════════════════════════════════════════
        // TIER 6: Spacing normalization (must be last)
        // ═══════════════════════════════════════════════════════════════
        const tier6Patterns = [
            { pattern: /\s*@\s*/g, replace: '@' },          // Spaces around @
            { pattern: /\s*\.\s*(?=[a-z]{2,4}$)/gi, replace: '.' }, // Spaces around . before TLD
            { pattern: /@([a-z]+)\s+\./gi, replace: '@$1.' }, // Space before dot in domain
        ];

        // Apply all tiers in order
        [...tier1Patterns, ...tier2Patterns, ...tier3Patterns,
        ...tier4Patterns, ...tier5Patterns, ...tier6Patterns].forEach(({ pattern, replace }) => {
            result = result.replace(pattern, replace);
        });

        return result;
    }

    /**
     * Clean corrupted TLD by extracting the valid TLD portion
     * Examples:
     *   info@example.ittel → info@example.it
     *   info@example.comlucca → info@example.com
     *   sendinfo@example.ito → sendinfo@example.it
     *   info@ristorante-esempio.comtel → info@ristorante-esempio.com
     *   .assistenza@negozio-esempio.itseguiseguiseguicontattaci → assistenza@negozio-esempio.it
     *   agenzia@hotmail.comwww.agenzia-esempio.com → agenzia@hotmail.com
     *   info@domain.itp.iva → info@domain.it
     */
    cleanTLD(email) {
        // STEP 0: Handle SINGLE-segment fake extensions (e.g., .com.tatsu, .it.iva).
        //
        // OF-1 / BG-13 FIX (2026-05-27): the pre-fix trailing character
        // class included the DOT, so the regex greedily consumed entire
        // subdomain chains. info@app.dev.example.com matched
        // "info@app.dev" (captured) and was trimmed to "info@app.dev" —
        // the BG-13 / OF-1 corruption. The trailing pattern below now
        // requires an explicit literal-dot separator followed by a
        // single trailing word/dash segment with no further dots, so
        // STEP 0 only fires for one-segment garbage like .tatsu, .iva,
        // .tel while preserving legitimate subdomain chains and
        // uncommon-TLD emails. Multi-dot trailing garbage like
        // .com.tatsu-X-Y.tatsu is no longer caught by STEP 0 (the
        // safety win for BG-13 / OF-1 outweighs the loss; that pattern
        // is rare for the italian-B2B target).
        //
        // TLDs ordered by LENGTH DESC to prevent .com → .co truncation
        // (previously .co was matched before .com, causing .com to be
        // seen as .co + garbage "m").
        const multiExtMatch = email.match(/^(.+@.+?\.(?:info|name|mobi|tech|shop|site|online|store|com|org|net|edu|gov|mil|biz|pro|app|dev|eu|uk|de|fr|es|nl|ch|at|be|us|ca|io|co|me|tv|it))\.[\-\w]+$/i);
        if (multiExtMatch && multiExtMatch[1]) {
            const cleanedEmail = multiExtMatch[1];
            logger.info(`[EmailExtractor] 🔧 CLEANED MULTI-EXT: ${email} → ${cleanedEmail}`);
            email = cleanedEmail;
        }

        // BLOCK-L5 FIX: Use centralized TLD list from CONFIG
        // Fallback to inline list if CONFIG not available (e.g., unit tests)
        const validTLDs = CONFIG?.extraction?.email?.validTLDs || [
            // 4+ chars first (fallback only)
            'info', 'name', 'mobi', 'asia', 'jobs', 'tech', 'shop', 'site', 'online', 'store',
            // 3 chars
            'com', 'org', 'net', 'edu', 'gov', 'mil', 'biz', 'pro', 'app', 'dev',
            // 2 chars (country codes) - LAST to prevent false matches
            'it', 'uk', 'de', 'fr', 'es', 'nl', 'ch', 'at', 'be', 'eu', 'us', 'ca',
            'io', 'co', 'me', 'tv', 'tel'
        ];

        const parts = email.split('@');
        if (parts.length !== 2) return email; // Invalid format, return as-is

        const [localPart, domainPart] = parts;
        const domainSegments = domainPart.split('.');

        if (domainSegments.length < 2) return email; // No TLD

        // ═══════════════════════════════════════════════════════════════════════════════
        // CRITICAL FIX (18 Dec 2025): Scan ALL segments LEFT-TO-RIGHT
        // Previous logic only checked the LAST segment, allowing intermediate garbage:
        //   agenzia@hotmail.comwww.agenzia-esempio.com
        //   → segments: ["hotmail", "comwww", "agenzia-esempio", "com"]
        //   → old code: checked only "com" (valid) → returned dirty email!
        //
        // New logic: Find FIRST valid TLD from left, cut everything after it
        // ═══════════════════════════════════════════════════════════════════════════════

        // Scan segments from left to right, looking for the FIRST valid TLD.
        //
        // OF-1 / BG-13 FIX (2026-05-27): exact-match branch now preserves
        // the email unconditionally. Pre-fix the branch trimmed at the
        // first valid TLD, corrupting legitimate subdomain chains
        // (info@app.dev.example.com → info@app.dev) and uncommon
        // last-segment TLDs (ceo@tech.app.foo.xyz → ceo@tech.app). True
        // garbage like "comwww" / "ittel" is still caught by the
        // starts-with branch below, which is unambiguous regardless of
        // last-segment shape.
        for (let i = 1; i < domainSegments.length; i++) {
            const segment = domainSegments[i].toLowerCase();

            // Exact valid TLD match → preserve (see OF-1 / BG-13 FIX above).
            if (validTLDs.includes(segment)) {
                return email;
            }

            // Check if segment STARTS with a valid TLD (e.g., "comwww" starts with "com")
            for (const validTLD of validTLDs) {
                if (segment.startsWith(validTLD) && segment.length > validTLD.length) {
                    // Found concatenated TLD: "comwww" → "com"
                    const garbageSuffix = segment.substring(validTLD.length);
                    logger.debug(`[EmailExtractor] 🔧 CLEANING SEGMENT: ${segment} → ${validTLD} (removing "${garbageSuffix}")`);

                    // Replace this segment with the clean TLD
                    domainSegments[i] = validTLD;

                    // Also cut everything AFTER this segment
                    const cleanSegments = domainSegments.slice(0, i + 1);
                    const cleanedEmail = `${localPart}@${cleanSegments.join('.')}`;
                    logger.info(`[EmailExtractor] ✓ CLEANED: ${email} → ${cleanedEmail}`);
                    return cleanedEmail;
                }
            }
        }

        // No valid TLD found anywhere, return as-is
        return email;
    }

    /**
     * Basic validation to filter junk
     * P1 OPTIMIZATION: Tiered filtering for performance
     * - TIER 1: Single regex catches 60%+ of false positives instantly
     * - TIER 2: Individual checks for remaining candidates
     */
    isValidEmail(email) {
        // Filter 0: Quick sanity check
        if (!email || email.length < 5 || !email.includes('@')) {
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // P1 OPTIMIZATION: TIER 1 - INSTANT REJECT REGEX
        // Single regex test catches most common false positives in one operation
        // This avoids running 18+ individual checks for obvious junk
        // ═══════════════════════════════════════════════════════════════════════════
        // BUG-EX-Tier1-Img: char class `[\.\$]` only matches literal `.` and `$`,
        // NOT end-of-string. Filter 1b at line ~556 explicitly tests both
        // `/@\d+x\./i` AND `/@\d+x$/i` — TIER 1's intent is the same. Replace
        // the char class with proper alternation so canonical `image@2x`
        // (end-of-string) is rejected here instead of falling through to TIER 2.
        // Test: tests/run-email-validator-tier1-node.mjs (audit/A4-email-validator).
        const INSTANT_REJECT = /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?|ttf|eot)$|@\d+x(\.|$)|^[\d\.\-]{6,}|@(example|test|placeholder|sample)\.|@www\./i;
        if (INSTANT_REJECT.test(email)) {
            logger.info(`[P1 OPTIMIZATION] ⚡ TIER1 INSTANT REJECT: ${email}`);
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // TIER 2: Individual checks for candidates that passed TIER 1
        // SL-011 NOTE: Some checks below intentionally overlap with TIER 1 regex.
        // This is deliberate for two reasons:
        // 1. SAFETY: Edge cases with unusual encodings may slip past regex
        // 2. DEBUGGING: Individual checks provide specific log messages
        // Performance impact is negligible (<1ms per email)
        // ═══════════════════════════════════════════════════════════════════════════

        // Filter 1: Image/file extensions (backup for edge cases TIER 1 missed)
        const fileExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.css', '.js', '.woff', '.woff2', '.ttf', '.eot'];
        if (fileExtensions.some(ext => email.toLowerCase().endsWith(ext))) {
            logger.debug(`[EmailExtractor] FILE EXTENSION filtered: ${email}`);
            return false;
        }

        // Filter 1b: Image size patterns (e.g., image@2x, icon@3x)
        if (/@\d+x\./i.test(email) || /@\d+x$/i.test(email)) {
            logger.debug(`[EmailExtractor] IMAGE SIZE PATTERN filtered: ${email}`);
            return false;
        }

        // Filter 2: Blacklist check
        const blacklist = this.config.extraction?.email?.blacklist || [];
        const domain = email.split('@')[1];
        if (blacklist.some(blocked => email.includes(blocked) || (domain && domain.includes(blocked)))) {
            logger.debug(`[EmailExtractor] BLACKLIST filtered: ${email}`);
            return false;
        }

        // Filter 3: Example/test/placeholder domains (expanded list)
        // BUG FIX: Added esempio.co and various esempio patterns to catch Italian placeholders
        const exampleDomains = [
            'esempio.it', 'esempio.co', 'esempio.', 'example.', 'test.',
            'ilmiosito.com', 'mysite.com', 'tuosito.it', 'yoursite.com',
            'placeholder.com', 'sample.com', 'tuodominio.it', 'yourdomain.com',
            'miosito.it', 'domain.com', 'demo.', 'fake.'
        ];
        if (exampleDomains.some(d => email.includes(d))) {
            logger.info(`[EmailExtractor] ⚡ PLACEHOLDER DOMAIN filtered: ${email}`);
            return false;
        }

        // Filter 4: Extremely long TLD (severe concatenation)
        const tld = email.split('.').pop();
        if (tld && tld.length > 12) {
            logger.debug(`[EmailExtractor] LONG TLD filtered: ${email}`);
            return false;
        }

        // Filter 5: Numeric + "info" prefix (phone artifacts like 0238231226info@)
        if (/^[\d\.\-]{3,}[a-z]+@/i.test(email)) {
            logger.debug(`[EmailExtractor] PHONE+TEXT PREFIX filtered: ${email}`);
            return false;
        }

        // Filter 6: Long numeric prefix (6+ digits)
        if (/^\d{6,}/.test(email)) {
            logger.debug(`[EmailExtractor] LONG NUMERIC filtered: ${email}`);
            return false;
        }

        // Filter 7: Known artifact suffixes
        if (email.endsWith('bottom') || email.endsWith('scrivici') || email.endsWith('sendsuccess')) {
            logger.debug(`[EmailExtractor] ARTIFACT SUFFIX filtered: ${email}`);
            return false;
        }

        // Filter 8: WordPress/CMS system emails
        if (email.includes('wordpress') || email.includes('wp-') || email.includes('admin@localhost')) {
            logger.debug(`[EmailExtractor] CMS SYSTEM filtered: ${email}`);
            return false;
        }

        // Filter 9: Common non-contact emails
        const nonContactPatterns = ['noreply@', 'no-reply@', 'donotreply@', 'mailer-daemon@', 'postmaster@', 'dpo@', 'privacy@', 'gdpr@', 'legal@'];
        if (nonContactPatterns.some(p => email.toLowerCase().startsWith(p))) {
            logger.debug(`[EmailExtractor] SYSTEM EMAIL filtered: ${email}`);
            return false;
        }

        // Filter 10: Third-party service emails & tracking platforms (EXPANDED)
        // BUG FIX: Added wixpress.co variant to catch .co TLD versions (truncated or intentional)
        const thirdPartyDomains = [
            // Social/Services
            'adobe.com', 'vimeo.com', 'youtube.com', 'facebook.com', 'twitter.com',
            'instagram.com', 'linkedin.com', 'mailchimp.com', 'sendgrid.com',
            // Tracking & Analytics platforms - catch both .com and .co variants
            'sentry.io', 'sentry.wixpress', 'wixpress.com', 'wixpress.co',
            'wix.com', 'wix.co', 'editorx.com',
            'hotjar.com', 'mixpanel.com', 'amplitude.com', 'segment.com',
            'googletagmanager.com', 'google-analytics.com',
            // Form services (contact forms embedded on websites)
            'jotform.com', 'typeform.com', 'formstack.com', 'wufoo.com',
            'cognito.com', 'formspree.io', 'netlify.app', 'getform.io'
        ];
        // Use includes() for domain check to catch subdomains
        const emailDomain = email.toLowerCase().split('@')[1] || '';
        if (thirdPartyDomains.some(d => emailDomain.includes(d))) {
            logger.info(`[EmailExtractor] ⚡ THIRD-PARTY/TRACKING filtered: ${email}`);
            return false;
        }

        // Filter 11: Sample/test emails
        // BUG FIX #4: Clean before checking to catch ":abc@xxx.com"
        const cleanedForCheck = email.toLowerCase().replace(/^["':;,]+/, '');
        const testEmails = ['sample@gmail.com', 'test@test.com', 'abc@xxx.com', 'user@example.com', 'email@email.com'];
        if (testEmails.includes(cleanedForCheck)) {
            logger.debug(`[EmailExtractor] TEST EMAIL filtered: ${email}`);
            return false;
        }

        // Filter 11b: UUID/hash patterns in local part (tracking emails)
        // Matches: 20+ consecutive hex characters like "18d2f96d279149989b95faf0a4b41882"
        let localPart = email.split('@')[0];
        if (localPart && /^[a-f0-9]{20,}$/i.test(localPart)) {
            logger.debug(`[EmailExtractor] UUID/HASH filtered: ${email}`);
            return false;
        }

        // Filter 12: Malformed (missing local part or weird characters)
        // Also catch leading dots that weren't cleaned (e.g., starting with .)
        if (!localPart || localPart.length < 1 || localPart.endsWith('.') || localPart.startsWith('.') || localPart.startsWith('-')) {
            logger.debug(`[EmailExtractor] MALFORMED filtered: ${email}`);
            return false;
        }

        // Filter 13: Suspiciously long local part (>40 chars often indicates concatenation)
        if (localPart.length > 40) {
            logger.debug(`[EmailExtractor] LOCAL PART TOO LONG filtered: ${email} (${localPart.length} chars)`);
            return false;
        }

        // Filter 15: Single-character local part (too short to be valid)
        if (localPart.length === 1) {
            logger.debug(`[EmailExtractor] SINGLE CHAR LOCAL filtered: ${email}`);
            return false;
        }

        // Filter 16: Purely numeric local part (like 1@mail.com, 2@mail.com)
        if (/^\d+$/.test(localPart)) {
            logger.debug(`[EmailExtractor] NUMERIC-ONLY LOCAL filtered: ${email}`);
            return false;
        }

        // Filter 17: Placeholder emails
        const placeholderEmails = ['your@email', 'mail@mail.com', 'email@email.com', 'placeholder_business@mail.com'];
        if (placeholderEmails.some(p => email.toLowerCase() === p)) {
            logger.debug(`[EmailExtractor] PLACEHOLDER filtered: ${email}`);
            return false;
        }

        // Filter 18: www. in domain (malformed)
        if (domain && domain.toLowerCase().startsWith('www.')) {
            logger.debug(`[EmailExtractor] WWW IN DOMAIN filtered: ${email}`);
            return false;
        }

        // Filter 14: Domain name repeated in local part (common concatenation artifact)
        // e.g., "il.azienda.esempioaziendaesempio@gmail.com"
        if (domain) {
            const domainBase = domain.split('.')[0].toLowerCase();
            if (domainBase.length > 3) {
                const localLower = localPart.toLowerCase();
                // Check if domain base appears multiple times in local part
                const firstIdx = localLower.indexOf(domainBase);
                const lastIdx = localLower.lastIndexOf(domainBase);
                if (firstIdx !== -1 && lastIdx !== -1 && firstIdx !== lastIdx) {
                    logger.debug(`[EmailExtractor] DOMAIN REPEATED filtered: ${email}`);
                    return false;
                }
            }
        }

        // Passed all filters - LOG AS VALID!
        logger.info(`[EmailExtractor] VALID EMAIL FOUND: ${email}`);
        return true;
    }

    /**
     * Clean email by removing common prefix artifacts
     * Handles: "email:info@", "mailto:info@", "1965info@", "webinfo@" etc.
     * @param {string} email - Raw email that might have prefix issues
     * @returns {string} - Cleaned email
     */
    cleanEmailPrefix(email) {
        if (!email) return email;

        const originalEmail = email;
        let localPart = email.split('@')[0];
        const domain = email.split('@')[1];

        if (!localPart || !domain) return email;

        // STEP 0: Remove unicode escape prefixes (e.g., u003e = > in JSON)
        localPart = localPart.replace(/^u003[ce]/gi, '');  // u003c = <, u003e = >
        localPart = localPart.replace(/^\\u003[ce]/gi, ''); // escaped version

        // STEP 0b: Remove leading dots (e.g., .assistenza@ → assistenza@)
        localPart = localPart.replace(/^\.+/, '');

        // STEP 1: Remove common label prefixes and phone artifacts
        const prefixPatterns = [
            /^%20/,                       // URL-encoded space
            /^mailto:/i,                  // mailto:info@ -> info@
            /^email:?/i,                  // email:info@ or emailinfo@ -> info@
            /^mail:?/i,                   // mail:info@ -> info@ (but not "mail" as part of email)
            /^e-mail:?/i,                 // e-mail:info@ -> info@
            /^["':;,<>]+/,                // Strip leading punctuation
            /^web(?=[a-z])/i,             // webinfo@ -> info@ (but preserve "webmaster")
            /^contact:?/i,                // contactinfo@ -> info@
            /^tel:?(?=\d)/i,             // tel:123 -> 123 (only if followed by digit)
            /^[\d\.\-]{1,15}(?=[a-zA-Z])/,  // Phone numbers: 02-66106053info@ -> info@
            /^information(?=[a-z])/i,     // informationinfo@ -> info@
            /^informazioni(?=[a-z])/i,    // Italian: informazionihello@ -> hello@
            /^italia(?=[a-z])/i,          // italiasusan@ -> susan@
            /^italy(?=[a-z])/i,          // italyernesto@ -> ernesto@
            /^mailsocial(?=@)/i,          // mailsocial@ is garbage prefix
        ];

        for (const pattern of prefixPatterns) {
            if (pattern.test(localPart)) {
                const newLocal = localPart.replace(pattern, '');
                // LIB-9 FIX (2026-05-11): pre-fix read
                //   `len >= 2 && includes('.') || len >= 3`
                // which JS parses as `(len >= 2 && includes('.')) || (len >= 3)`
                // — `&&` binds tighter than `||`. The first clause is
                // effectively vacuous in this context (a 2-char local-part
                // with a dot is structurally impossible / invalid per RFC
                // 5321), so the predicate reduces to `len >= 3`. Behavior
                // is unchanged, but the un-parenthesized form is a known
                // operator-precedence trap that confuses linters and
                // reviewers. Make the intent explicit.
                if ((newLocal.length >= 2 && newLocal.includes('.')) || newLocal.length >= 3) {
                    localPart = newLocal;
                    logger.debug(`[EmailExtractor] Cleaned prefix: ${originalEmail} -> ${localPart}@${domain}`);
                }
            }
        }

        // STEP 2: Check for common email starts in the middle of local part
        // e.g., "75elisabandonievents@" where "75" is garbage
        // P2-003 FIX: Only clean if prefix is clearly garbage (numeric or single char)
        // to prevent truncating valid emails like "ainfo@company.com"
        const commonStarts = ['info', 'contact', 'hello', 'ciao', 'support', 'sales', 'booking', 'prenotazioni', 'eventi', 'wedding'];

        for (const start of commonStarts) {
            const idx = localPart.toLowerCase().indexOf(start);
            // Only extract if:
            // 1. Found in the middle (not at start)
            // 2. Prefix is CLEARLY garbage (numeric only OR single char)
            if (idx > 0 && idx <= 10) {
                const prefix = localPart.substring(0, idx);
                // P2-003 FIX: Stricter check - only extract if prefix is:
                // - Purely numeric (phone artifact like "1965info@")
                // - Single character (parsing error like "ninfo@")
                if (/^\d+$/.test(prefix) || prefix.length === 1) {
                    const cleaned = localPart.substring(idx) + '@' + domain;
                    logger.debug(`[EmailExtractor] Extracted from middle: ${originalEmail} -> ${cleaned}`);
                    return cleaned;
                }
            }
        }

        // STEP 3: Check for domain name in local part (duplication artifact)
        // e.g., "aziendaesempioaziendaesempio@gmail.com" -> try to extract cleaner version
        const domainBase = domain.split('.')[0].toLowerCase();
        if (domainBase.length > 4 && domainBase !== 'gmail' && domainBase !== 'yahoo' && domainBase !== 'hotmail') {
            const localLower = localPart.toLowerCase();
            const idx = localLower.indexOf(domainBase);
            if (idx > 0) {
                // Domain found in middle of local part - might be concatenation
                // e.g., "1965ilgrappoloil.azienda.esempio" with domain "gmail"
                // Try to find a sensible email pattern
                const afterDomain = localPart.substring(idx);
                if (afterDomain.includes('.') || afterDomain.length > domainBase.length) {
                    // There's more after the domain match - extract it
                    const cleaned = afterDomain + '@' + domain;
                    logger.debug(`[EmailExtractor] Extracted after domain match: ${originalEmail} -> ${cleaned}`);
                    return cleaned;
                }
            }
        }

        return localPart + '@' + domain;
    }

    /**
     * BUG #5 FIX: Sanitize email for safe display/storage
     * Removes characters that could cause XSS or injection
     * @param {string} email - Raw email
     * @returns {string} - Sanitized email
     */
    sanitizeEmail(email) {
        if (!email || typeof email !== 'string') return '';

        // Remove XSS-dangerous characters
        let sanitized = email
            .replace(/['"<>]/g, '')      // Remove quotes and angle brackets
            .replace(/javascript:/gi, '') // Remove javascript: protocol
            .replace(/on\w+=/gi, '')      // Remove event handlers
            .replace(/[\x00-\x1F]/g, '')  // Remove control characters
            .trim();

        // Validate structure remains intact
        if (!sanitized.includes('@') || !sanitized.includes('.')) {
            return '';
        }

        return sanitized;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SL-006 FIX: Singleton pattern for EmailExtractor
// Avoids repeated instantiation overhead - reuses single instance
// ═══════════════════════════════════════════════════════════════════════════
let _emailExtractorInstance = null;

/**
 * Get singleton EmailExtractor instance
 * @param {Object} config - Optional config (only used on first call)
 * @returns {EmailExtractor} Singleton instance
 */
export function getEmailExtractor(config = {}) {
    if (!_emailExtractorInstance) {
        _emailExtractorInstance = new EmailExtractor(config);
        logger.debug('[SL-006] EmailExtractor singleton created');
    }
    return _emailExtractorInstance;
}

/**
 * Reset singleton (for testing purposes only)
 */
export function resetEmailExtractor() {
    _emailExtractorInstance = null;
}

export default EmailExtractor;

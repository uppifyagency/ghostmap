/**
 * Export-time email/status sanitization — SINGLE SOURCE OF TRUTH (lib layer).
 *
 * BUG-5 #5.1 (2026-07-07): these helpers used to live in
 * background/data-exporter.js (the UI export path). lib/ExportAPI.js (the
 * API-gated export path) hand-rolled a DIVERGENT, weaker copy — a hardcoded
 * block list WITHOUT the CONFIG blacklist and a substring match that dropped
 * legitimate look-alikes (the EXP-02 regression) — and derived Scrape Status from
 * the RAW email, so a fully-blacklisted record exported an empty Email cell but a
 * "success" status (the status lied). Extracting the canonical logic here (a
 * lib-layer module both paths can import — no lib→background layering inversion)
 * makes the two export surfaces byte-identical and kills the divergence.
 *
 * data-exporter.js re-exports cleanEmailsForCsv/deriveScrapeStatus for existing
 * importers (tests, generateCSV); the definitions now live ONLY here.
 */
import { CONFIG } from './config.js';
import { SKIPPED_INVALID_URL } from './businessUpdates.js';

/** Centralized email blacklist (single source of truth). */
export const getEmailBlacklist = () => CONFIG.extraction.email.blacklist;

/**
 * Clean emails for CSV/Markdown/JSON export - applies same filtering everywhere.
 * Removes: CONFIG-blacklisted domains (suffix-match), UUID/hash local parts,
 * truncated local parts, generic test patterns.
 * @param {string} rawEmails - Comma/semicolon-separated email string from database
 * @returns {string} - Cleaned comma-separated emails
 */
export function cleanEmailsForCsv(rawEmails) {
    if (!rawEmails || typeof rawEmails !== 'string') return '';

    // BLOCK-M1 FIX: Use centralized blacklist from CONFIG (single source of truth)
    const blockedDomains = getEmailBlacklist();

    const emails = rawEmails.split(/[,;]/).map(e => e.trim()).filter(e => e);
    const cleanedEmails = [];

    for (const email of emails) {
        const cleanEmail = email.toLowerCase().trim();

        // Skip empty
        if (!cleanEmail || !cleanEmail.includes('@')) continue;

        const [localPart, domain] = cleanEmail.split('@');

        // Skip if no valid structure
        if (!localPart || !domain) continue;

        // EXP-02 FIX (2026-06-09): suffix-match, NOT substring. The extraction
        // filters (offscreen/parser.js:428, background/index.js) already use this
        // exact form. `domain.includes(d)` wrongly dropped legitimate addresses
        // whose domain merely CONTAINS a blacklist entry — e.g. negoziowix.com
        // vs `wix.co`, ecotest.com vs `test.co`, subdomain.com vs `domain.co`.
        // Those emails were in the DB but silently vanished from CSV/MD exports.
        if (blockedDomains.some(d => domain === d || domain.endsWith('.' + d))) continue;

        // Skip UUID/hash-like local parts (20+ hex chars)
        if (localPart.length >= 20 && /^[a-f0-9]+$/.test(localPart)) continue;

        // Skip truncated emails (local part too short, likely extraction error)
        if (localPart.length < 2) continue;

        // Skip generic test patterns
        if (cleanEmail === 'user@domain.com' || cleanEmail === 'abc@xxx.com') continue;

        cleanedEmails.push(email.trim());
    }

    return cleanedEmails.join(', ');
}

/**
 * BUG-5 (2026-07-07): derive the "Scrape Status" cell from the email the user
 * ACTUALLY sees — i.e. the POST-clean value (blacklist + garbage filtered by
 * cleanEmailsForCsv) — never the raw `business.email`.
 *
 * The old inline derivation `emailScraped ? (email ? 'success' : 'no_email')
 * : 'pending'` read the RAW email, so a record whose only stored address was
 * blacklisted (e.g. office@yourcompany.com) exported an EMPTY Email cell yet a
 * "success" status: the status lied about the cell.
 *
 * Honest states (coherent with the Email cell):
 *   - 'pending'             — not scraped yet (emailScraped falsy)
 *   - 'success'             — a usable email survived the filter and is shown
 *   - 'skipped_invalid_url' — BUG-7: the website was NEVER fetched because its URL
 *                             is structurally un-scrapable. Distinct from
 *                             'no_email' (implies we DID scrape) and 'scrape_failed'.
 *   - 'scrape_failed'       — scraped, no usable email, and an error was recorded
 *   - 'no_email'            — scraped, no usable email, no error (site had none, or
 *                             everything found was blacklisted/garbage). Truthful:
 *                             the Email cell is empty in this case.
 *
 * @param {{emailScraped?: boolean, scrapeError?: string|null, scrapedFrom?: string}} business
 * @param {string} cleanedEmail - result of cleanEmailsForCsv(business.email)
 * @returns {'pending'|'success'|'skipped_invalid_url'|'scrape_failed'|'no_email'}
 */
export function deriveScrapeStatus(business, cleanedEmail) {
    const b = business || {};
    if (!b.emailScraped) return 'pending';
    // A usable email in the (post-filter) cell always wins: 'success' stays
    // coherent with a non-empty Email cell even if the row also carries a marker.
    if (cleanedEmail) return 'success';
    // BUG-7: the URL was never fetched — surface the explicit, honest reason
    // instead of 'no_email' (which would imply we attempted a scrape).
    if (b.scrapedFrom === SKIPPED_INVALID_URL) return SKIPPED_INVALID_URL;
    if (b.scrapeError) return 'scrape_failed';
    return 'no_email';
}

/**
 * Escape a value for a Markdown TABLE cell — SSOT for all export MD cells.
 * A raw `|` splits the cell into extra columns (column-shift); a raw newline
 * breaks the row. Neutralises both. Extends the `|`→`/` the MD exporter already
 * applied to title/category to EVERY cell (website/phone were emitted raw).
 * @param {*} value
 * @returns {string}
 */
export function escapeMarkdownCell(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '/');
}

export default { getEmailBlacklist, cleanEmailsForCsv, deriveScrapeStatus, escapeMarkdownCell };

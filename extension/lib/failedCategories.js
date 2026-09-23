/**
 * "Failed business" categorization — SINGLE SOURCE OF TRUTH (lib layer).
 *
 * S11 FIX (2026-08-18): this predicate used to live INSIDE ui/failed-modal.js,
 * which forced the modal to pull the ENTIRE DB over sendMessage
 * (`get_all_businesses`, multi-MB serialization) just to filter client-side.
 * Moving it here (verbatim — E6 cleaned-email SSOT preserved) lets the SW's
 * `get_failed_businesses` action filter server-side with the EXACT same
 * algorithm the modal uses for display — one predicate, two consumers, no
 * drift. Consumers:
 *   • background/index.js `case 'get_failed_businesses'` — membership filter
 *     (categorizeFailure(b) !== null) over the DB, returns only the subset.
 *   • ui/failed-modal.js — category assignment for counts/sections/CSV.
 *
 * RELATION TO THE SW RETRY-SET (lib/db.js getFailedBusinesses — the set
 * `retry_failed_businesses` acts on: `hasWebsite && !isSkippedInvalidUrl &&
 * (hasScrapeError || scrapedButNoEmail)`). The two predicates are
 * INTENTIONALLY different and stay separate:
 *   • This one answers "what should the user SEE as failed" (diagnostic set);
 *     the retry-set answers "what can we RETRY" (actionable subset).
 *   • Modal-only EXTRA categories (in this set, NOT retryable):
 *       - noWebsite: nothing to fetch — but the user must see it;
 *       - scrapedFrom 'skipped_invalid_url' (BUG-7): retrying would destroy
 *         the honest skip label, so the retry-set excludes it; shown here as
 *         'noEmail';
 *       - blacklisted-only email (E6): raw email truthy but cleaned value
 *         empty — the retry-set's raw-email check skips it (pre-existing).
 *   • Retry-only divergence (pre-existing, documented): a row with a USABLE
 *     email but a scrapeError is in the retry-set yet hidden here (hasEmail
 *     short-circuits). Changing retry semantics is out of scope for S11.
 *   • The S8 'circuit_open' rows (emailScraped:true +
 *     scrapeError:'circuit_open') are in BOTH sets — categorized 'error' here.
 * Test: tests/run-s11-failed-modal-slim-payload-node.mjs pins this matrix.
 *
 * Pure module — no chrome/DOM at eval; import chain (exportSanitize → config →
 * businessUpdates) is equally pure, so it is safe in the SW, UI pages and node.
 */

import { cleanEmailsForCsv } from './exportSanitize.js';

/**
 * Categorize a business into failure type
 * FIXED: Proper categorization logic without double-counting
 *
 * @param {Object} business - Business object
 * @returns {string|null} - Category key ('noEmail' | 'cloudflare' | 'error' |
 *                          'noWebsite') or null if not a failure
 */
export function categorizeFailure(business) {
    const hasWebsite = business.website && business.website.trim() !== '';
    const wasScraped = business.emailScraped === true;
    // E6 (ATP 2026-07-17): count "usable email" via the SSOT blacklist filter,
    // NOT raw business.email truthiness. A business whose only emails are
    // blacklisted/garbage has business.email truthy but cleanEmailsForCsv → '',
    // so the raw check under-counted failures vs the authoritative CSV.
    const hasEmail = cleanEmailsForCsv(business.email).trim() !== '';
    const hasError = business.scrapeError && business.scrapeError.trim() !== '';

    // If business has an email, it's not a failure
    if (hasEmail) {
        return null;
    }

    // Check for Cloudflare errors (highest priority for categorization)
    if (hasError) {
        const errorLower = business.scrapeError.toLowerCase();
        if (errorLower.includes('cloudflare') ||
            business.scrapeError === 'cloudflare_protected') {
            return 'cloudflare';
        }
    }

    // Business was scraped but no email found
    if (wasScraped) {
        if (hasError) {
            // Had an error during scraping (timeout, fetch error, etc.)
            return 'error';
        } else {
            // Scraped successfully but no email on site
            return 'noEmail';
        }
    }

    // Business has no website - couldn't be scraped
    if (!hasWebsite) {
        return 'noWebsite';
    }

    // Business not yet scraped, not a failure (pending)
    return null;
}

export default { categorizeFailure };

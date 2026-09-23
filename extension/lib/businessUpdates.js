/**
 * Build the DB `updates` patch for an email-scrape result.
 *
 * PIVA-01 FIX (2026-06-09): partitaIva / codiceFiscale / social are
 * ACCUMULATIVE enrichment fields. updateBusiness() in lib/db.js performs a
 * full `put` (not a hole-filling merge), so any key present in `updates`
 * overwrites the stored value. A failed or empty re-scrape (site down,
 * Cloudflare, fetch error, or a high-confidence early-exit before the page
 * carrying the P.IVA was reached) leaves italianTaxCodes = {null,null} and
 * socialLinks = {} — writing those keys unconditionally erased valid values
 * saved by a previous run. The most common trigger is the "Retry Failed"
 * button, whose targets are exactly the businesses that carry a P.IVA in the
 * footer but no email.
 *
 * Fix: emit partitaIva/codiceFiscale/social ONLY when this run actually found
 * a value, so the spread `{ ...business, ...updates }` preserves prior
 * enrichment. The per-scrape fields (email, emailScraped, scrapedAt,
 * scrapedFrom) are still written every run — they represent the current
 * scrape truth.
 *
 * BUG-3 FIX (2026-07-07): the PIVA-01 guard `Object.keys(socialLinks).length
 * > 0` was vacuous for social — offscreen/parser.js extractSocialLinks()
 * ALWAYS returns a 6-key object with null for platforms it did not find, so
 * every successful re-scrape of a site without socials wrote
 * `social = {facebook: null, …}` and the full put erased socials acquired by
 * previous runs. Fix: only FOUND (non-null, non-empty) values count; they are
 * merged per-key over the snapshot's existing social (`existingSocial`),
 * because `updates.social` replaces the WHOLE stored object on the full put.
 * An all-null/empty scrape emits no `social` key at all.
 *
 * @param {object}   args
 * @param {string[]} args.emailList       normalized emails found this run
 * @param {object}   [args.socialLinks]   { platform: url|url[] } map (may be {} or null-filled)
 * @param {object}   [args.italianTaxCodes] { partitaIva, codiceFiscale } (may be nulls)
 * @param {string}   [args.scrapedFrom]   page the result came from (falsy → 'failed')
 * @param {Error}    [args.lastError]     last error, recorded only when no email found
 * @param {object}   [args.existingSocial] the stored business's current social map;
 *                                         its non-null keys are preserved under the
 *                                         values found this run (BUG-3). Pass the
 *                                         CURRENT record's social (read inside the
 *                                         merge tx), NOT the job-start snapshot
 *                                         (BUG-4 #4.3), so a concurrently-written
 *                                         platform is never dropped.
 * @param {string}   [args.existingPartitaIva] the CURRENT record's validated P.IVA
 *                                         (read inside the merge tx). When present,
 *                                         a run that found only an invalid raw
 *                                         candidate does NOT write partitaIvaRaw —
 *                                         avoids polluting col 54 next to a valid
 *                                         col 6 (BUG-8 P2).
 * @returns {object} updates patch safe to spread over the stored business
 */
export function buildBusinessUpdates({ emailList, socialLinks, italianTaxCodes, scrapedFrom, lastError = null, existingSocial, existingPartitaIva } = {}) {
    const emails = Array.isArray(emailList) ? emailList : [];
    const updates = {
        email: emails.join(', ') || '',
        emailScraped: true,
        scrapedAt: Date.now(),
        scrapedFrom: scrapedFrom || 'failed',
    };

    // Accumulative enrichment — write ONLY when present this run, otherwise a
    // failed/empty re-scrape would clobber values from a previous run.
    if (italianTaxCodes && italianTaxCodes.partitaIva) {
        updates.partitaIva = italianTaxCodes.partitaIva;
        // BUG-8 #8.1: a freshly validated P.IVA supersedes any raw candidate a
        // previous run may have parked in col 54 — clear it so the export never
        // shows a stale unvalidated grezzo next to a valid number.
        updates.partitaIvaRaw = null;
    } else if (italianTaxCodes && italianTaxCodes.partitaIvaRaw && !existingPartitaIva) {
        // BUG-8 #8.1: extraction found something that LOOKS like a P.IVA but
        // failed the checksum (OCR/typo, foreign VAT). Preserve the rejected
        // candidate so it surfaces in the "Partita IVA (Raw/Unvalidated)" column
        // instead of vanishing silently. `partitaIva` is deliberately NOT written
        // here, so a valid value from a previous run is preserved by the merge.
        // BUG-8 P2 (2026-07-07): but do NOT write the raw when the CURRENT record
        // already holds a checksum-VALID P.IVA (`existingPartitaIva`, read inside
        // the merge tx) — that would show a valid col 6 next to noise in col 54.
        updates.partitaIvaRaw = italianTaxCodes.partitaIvaRaw;
    }
    if (italianTaxCodes && italianTaxCodes.codiceFiscale) {
        updates.codiceFiscale = italianTaxCodes.codiceFiscale;
    }
    // BUG-3: count only FOUND values (the parser emits null for every platform
    // it did not find, so a raw key-count guard is always true). When at least
    // one platform was found, merge per-key over the snapshot's social so the
    // full put can't drop platforms found by previous runs.
    const foundSocial = pickFoundSocial(socialLinks);
    if (Object.keys(foundSocial).length > 0) {
        // W1 (ATP 2026-07-17): UNION over the snapshot's social so an array
        // (multi-link) platform can't lose a previously-acquired URL when a
        // later run re-finds only a subset. SSOT: mergeSocialMaps.
        updates.social = mergeSocialMaps(existingSocial, socialLinks);
    }

    // scrapeError is only meaningful when this run produced no email.
    if (updates.email === '' && lastError) {
        updates.scrapeError = lastError.message;
    }

    // FORENSIC-2026-06-10 Fase 0: clear a stale scrapeError on success.
    // updateBusiness() is a full put — without this, a scrapeError recorded by
    // a previous failed run survives the successful re-scrape, and
    // getFailedBusinesses() (truthiness check) re-lists the business in
    // "Retry Failed" forever even though it now has an email.
    if (updates.email !== '') {
        updates.scrapeError = null;
    }

    return updates;
}

/**
 * BUG-3: keep only the platforms that actually carry a value.
 *
 * A social value counts as FOUND when it is a non-empty string or a non-empty
 * array (multi-link platforms come back as arrays, BLOCK-9/MED-011). null,
 * undefined, '' and [] are "not found this scrape" and must never travel into
 * a merge, where they would overwrite real values.
 *
 * @param {object} [social] platform → url|url[] map (any producer shape)
 * @returns {object} sparse copy with only found values
 */
function pickFoundSocial(social) {
    const found = {};
    if (!social || typeof social !== 'object' || Array.isArray(social)) {
        return found;
    }
    for (const [platform, value] of Object.entries(social)) {
        if (value == null || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        found[platform] = value;
    }
    return found;
}

/**
 * W1 (ATP 2026-07-17): normalize a social value to an array of non-empty URLs.
 * @private
 */
function _asSocialArray(v) {
    if (v == null || v === '') return [];
    return Array.isArray(v) ? v.filter(u => typeof u === 'string' && u !== '') : [v];
}

/**
 * W1 (ATP 2026-07-17): merge one platform's existing vs found value.
 *
 * Scalar-vs-scalar → found wins (BUG-3.5 invariant: the latest scrape is
 * authoritative for that platform). If EITHER side is an array (multi-link
 * platform) → UNION (found URLs first, then existing extras, deduped) so a
 * subset re-scrape can never drop a previously-acquired URL. A single-URL
 * union collapses back to a scalar (preserves the dominant shape).
 * @private
 */
function _unionSocialValue(existing, found) {
    if (!Array.isArray(existing) && !Array.isArray(found)) return found;
    const seen = new Set();
    const urls = [];
    for (const u of [..._asSocialArray(found), ..._asSocialArray(existing)]) {
        if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
    return urls.length === 1 ? urls[0] : urls;
}

/**
 * W1 (ATP 2026-07-17): SSOT social merge consumed by BOTH mergeSocialLinks
 * (intra-job accumulator) and buildBusinessUpdates (cross-run save). Only
 * FOUND (non-null/non-empty) values on either side participate; a platform
 * present on just one side is preserved verbatim; a platform on both sides is
 * merged via _unionSocialValue (array-union / scalar-found-wins).
 *
 * @param {object} [base]     platform → url|url[] map (any producer shape)
 * @param {object} [incoming] platform → url|url[] map (any producer shape)
 * @returns {object} sparse merged map
 */
export function mergeSocialMaps(base, incoming) {
    const a = pickFoundSocial(base);
    const b = pickFoundSocial(incoming);
    const out = {};
    for (const platform of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(platform in b)) { out[platform] = a[platform]; continue; }
        if (!(platform in a)) { out[platform] = b[platform]; continue; }
        out[platform] = _unionSocialValue(a[platform], b[platform]);
    }
    return out;
}

/**
 * BUG-3: null-safe intra-job accumulator for social links.
 *
 * Replaces the raw `{ ...socialLinks, ...result.socialLinks }` spreads and
 * plain overwrites in background/email-scraper-v2.js: found values always
 * accumulate/refresh; null/empty keys from a page without socials never
 * clobber values captured earlier in the same job. Always returns a sparse
 * object (no null keys), which also makes the buildBusinessUpdates guard
 * meaningful again.
 *
 * @param {object} [base]     socials accumulated so far in this job
 * @param {object} [incoming] socials extracted from the latest page
 * @returns {object} sparse merged map (incoming found values win per-key)
 */
export function mergeSocialLinks(base, incoming) {
    return mergeSocialMaps(base, incoming);
}

/**
 * BUG-7 (2026-07-07): single source of truth for the marker that flags a
 * business whose website was SKIPPED for email scraping because its URL is
 * structurally un-scrapable — a social/marketplace domain, a host with no dot,
 * a non-http scheme, etc. (see background/email-scraper-v2.js
 * `isValidScrapableUrl`).
 *
 * The literal was previously duplicated across the producer
 * (background/index.js addJobsInBatches), the retry-set filter
 * (getFailedBusinessesFromDB) and — after this fix — the export status
 * derivation (background/data-exporter.js deriveScrapeStatus). A typo in any one
 * copy would silently break the honesty invariant (the export would fall back to
 * 'no_email', re-introducing BUG-7). Centralizing it here removes that risk.
 */
export const SKIPPED_INVALID_URL = 'skipped_invalid_url';

/**
 * BUG-7 (2026-07-07): build the DB patch that marks a business as SKIPPED
 * because its website URL is structurally un-scrapable.
 *
 * This is NOT a scrape outcome — the site is never fetched — so the record must
 * be honestly distinguishable from both a real success and a genuine
 * "scraped, found nothing" (`no_email`). The pre-fix marker set
 * `{ emailScraped:true, scrapedFrom:'skipped_invalid_url' }` but NEITHER a
 * timestamp NOR anything the export understood, so the CSV lied twice: Scrape
 * Status showed `no_email` (implying we tried) and "Scraped At" was empty.
 *
 * Invariants this patch guarantees:
 *  - `emailScraped:true`  → the record leaves getBusinessesForEmailScraping's
 *    candidate set (`website && !emailScraped`), so the automatic queue never
 *    re-picks it → no infinite retry loop on a URL that can never succeed.
 *  - `scrapedFrom:SKIPPED_INVALID_URL` → an EXPLICIT reason the export surfaces
 *    (deriveScrapeStatus) and getFailedBusinessesFromDB uses to keep the row out
 *    of the "Retry Failed" count.
 *  - `scrapedAt:Date.now()` → stamps the instant the row was processed/skipped
 *    so the "Scraped At" column stops lying about the "when".
 *
 * @returns {{emailScraped: true, scrapedFrom: string, scrapedAt: number}}
 */
export function buildInvalidUrlSkipUpdate() {
    return {
        emailScraped: true,
        scrapedFrom: SKIPPED_INVALID_URL,
        scrapedAt: Date.now(),
    };
}

/**
 * S8 (2026-08-18): SSOT for the circuit-open outcome markers.
 *
 * CIRCUIT_OPEN_ERROR is the message of the retry-eligible error the email
 * scraper's entry gate throws when the domain breaker is open
 * (background/email-scraper-v2.js). background/index.js onJobFailed matches
 * it to detect "retries exhausted because the breaker never closed".
 *
 * CIRCUIT_OPEN_MARKER is the scrapedFrom/scrapeError value stamped on the
 * business row for that permanent outcome.
 */
export const CIRCUIT_OPEN_ERROR = 'CIRCUIT_OPEN';
export const CIRCUIT_OPEN_MARKER = 'circuit_open';

/**
 * S8 (2026-08-18): build the DB patch that marks a business whose email-scrape
 * job exhausted ALL its retries because the domain circuit breaker stayed open
 * through every attempt.
 *
 * Pre-fix the circuit-open path returned `{skipped:true}` and the JobQueue
 * counted it SUCCESS: the row stayed `emailScraped:false` with no marker, the
 * job was gone, and the business silently never got enriched in that run.
 * Post-fix the gate throws a retry-eligible CIRCUIT_OPEN error; when retries
 * run out, index.js onJobFailed applies THIS patch (same honesty convention as
 * BUG-7's buildInvalidUrlSkipUpdate and the cloudflare_protected save):
 *
 *  - `emailScraped:true` → leaves getBusinessesForEmailScraping's candidate
 *    set, so the automatic queue can't loop on a gated domain.
 *  - `scrapedFrom/scrapeError: CIRCUIT_OPEN_MARKER` → deriveScrapeStatus
 *    surfaces 'scrape_failed' (never success/no_email) and the row stays in
 *    the "Retry Failed" set — the user can retry once the breaker closed.
 *  - `scrapedAt:Date.now()` → honest processing timestamp.
 *  - deliberately NO `email:''` key: the patch is applied via
 *    updateBusinessMerge, so prior enrichment is preserved.
 *
 * @returns {{emailScraped: true, scrapedFrom: string, scrapeError: string, scrapedAt: number}}
 */
export function buildCircuitOpenFailureUpdate() {
    return {
        emailScraped: true,
        scrapedFrom: CIRCUIT_OPEN_MARKER,
        scrapeError: CIRCUIT_OPEN_MARKER,
        scrapedAt: Date.now(),
    };
}

export default {
    buildBusinessUpdates, mergeSocialLinks, buildInvalidUrlSkipUpdate, SKIPPED_INVALID_URL,
    buildCircuitOpenFailureUpdate, CIRCUIT_OPEN_ERROR, CIRCUIT_OPEN_MARKER,
};

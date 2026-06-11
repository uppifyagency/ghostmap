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
 * @param {object}   args
 * @param {string[]} args.emailList       normalized emails found this run
 * @param {object}   [args.socialLinks]   { platform: url } map (may be {})
 * @param {object}   [args.italianTaxCodes] { partitaIva, codiceFiscale } (may be nulls)
 * @param {string}   [args.scrapedFrom]   page the result came from (falsy → 'failed')
 * @param {Error}    [args.lastError]     last error, recorded only when no email found
 * @returns {object} updates patch safe to spread over the stored business
 */
export function buildBusinessUpdates({ emailList, socialLinks, italianTaxCodes, scrapedFrom, lastError = null } = {}) {
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
    }
    if (italianTaxCodes && italianTaxCodes.codiceFiscale) {
        updates.codiceFiscale = italianTaxCodes.codiceFiscale;
    }
    if (socialLinks && Object.keys(socialLinks).length > 0) {
        updates.social = socialLinks;
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

export default { buildBusinessUpdates };

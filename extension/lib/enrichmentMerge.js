/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

import { isValidPhone } from './utils.js';
import { isPlausibleRating, isPlausibleReviewCount, isPlausibleLatitude, isPlausibleLongitude } from './rangeGuards.js';

/**
 * Enrichment (detail-fetch) per-field merge patch.
 *
 * Extracted from background/index.js `_doEnrichmentMerge` (BUG-4 inverse fix,
 * 2026-07-07) so the field-by-field merge policy is (a) pure + unit-testable in
 * Node and (b) runnable INSIDE a single IndexedDB readwrite transaction via
 * `db.updateBusinessMerge(key, current => computeEnrichmentPatch(current, f))`.
 *
 * Why atomic: the enrichment previously read its snapshot with `getBusiness`,
 * computed a merged object, then full-put `saveBusiness(merged)`. If the
 * email-scraper wrote email/emailScraped/social/partitaIva into the DB between
 * that read and that write, the full put REGRESSED them to the stale enrichment
 * snapshot — the same data-loss class as BUG-4, in the opposite direction.
 * Computing the patch against the CURRENT record inside the tx closes it.
 *
 * Returns a SPARSE patch (only the fields this enrichment should change);
 * `updateBusinessMerge` spreads it over the current record, so every field NOT
 * in the patch (email, social, partitaIva, codiceFiscale, …) is preserved.
 *
 * Merge policy (unchanged from the pre-fix `_doEnrichmentMerge`):
 *   • hole-fill scalars (placeId, description, phone, address, website,
 *     lastUpdatedByOwner, hoursRaw): set ONLY when current is empty.
 *   • claimStatus: set only when current is empty/"unknown" and the incoming
 *     value is a real (non-"unknown") status.
 *   • reviewThemes: replace only when the incoming array is at least as long as
 *     the current one (richer wins, never shrink).
 *   • reviewDistribution: replace only when the incoming totals are ≥ current.
 *   • latitude/longitude/rating/reviewCount/hoursDaysFound: hole-fill WITH the
 *     type/range guards (EXP-01 coords, BUG-1 rating, BUG-2/DEBT-CSV-1
 *     reviewCount — page-forgeable MAIN-world bridge, must stay guarded).
 *
 * @param {object} current the CURRENT DB record (wins on every populated field)
 * @param {object} fields  detail-fetch payload.fields
 * @returns {object} sparse patch to spread over `current`
 */
export function computeEnrichmentPatch(current, fields) {
    const cur = current || {};
    const f = fields || {};
    const patch = {};

    if (!cur.placeId && f.placeId) patch.placeId = f.placeId;
    if (!cur.description && f.description) patch.description = f.description;
    if ((!cur.claimStatus || cur.claimStatus === 'unknown') && f.claimStatus && f.claimStatus !== 'unknown') {
        patch.claimStatus = f.claimStatus;
    }
    if (!cur.lastUpdatedByOwner && f.lastUpdatedByOwner) {
        patch.lastUpdatedByOwner = f.lastUpdatedByOwner;
    }
    if (Array.isArray(f.reviewThemes) && f.reviewThemes.length > 0) {
        const existingCount = Array.isArray(cur.reviewThemes) ? cur.reviewThemes.length : 0;
        if (f.reviewThemes.length >= existingCount) {
            patch.reviewThemes = f.reviewThemes;
        }
    }
    if (f.reviewDistribution && typeof f.reviewDistribution === 'object') {
        const sum = (d) => Object.values(d || {}).reduce((a, b) => a + (Number(b) || 0), 0);
        if (sum(f.reviewDistribution) >= sum(cur.reviewDistribution)) {
            patch.reviewDistribution = f.reviewDistribution;
        }
    }
    // BR-1 (2026-07-17): mirror the F8/BUG-2 numeric guards below — `phone` is a
    // page-forgeable MAIN-world bridge field (observer.js:540 relays it raw) and
    // lands in the CSV Phone cell. Reject anything isValidPhone rejects so a
    // hostile `+39\",=cmd|…` can never reach the export mouth. Same chokepoint as
    // rating/reviewCount — validation stays in this pure merge, not the relay.
    if (!cur.phone && f.phone && isValidPhone(f.phone)) patch.phone = f.phone;
    if (!cur.address && f.address) patch.address = f.address;
    if (!cur.website && f.website) patch.website = f.website;
    // EXP-01: type+range validated (different trust boundary than the content script) → shared predicate in lib/rangeGuards.js (BR-3).
    if (cur.latitude == null && isPlausibleLatitude(f.latitude)) {
        patch.latitude = f.latitude;
    }
    if (cur.longitude == null && isPlausibleLongitude(f.longitude)) {
        patch.longitude = f.longitude;
    }
    // F8 (2026-07-07): rating lands UNESCAPED in the CSV "Rating" cell
    // (data-exporter.js ~460: `b.rating || ''`, no escapeCsv) and arrives over
    // the page-forgeable MAIN-world bridge — mirror the reviewCount numeric guard
    // below. A STRING rating (e.g. "4,4" with an Italian decimal comma) would
    // column-shift the CSV row (Reviews spills into Address). Range 0–5 matches
    // the BUG-1 SelectorEngine acquisition validator and the coord/reviewCount
    // range guards above (defense-in-depth: latent today, but the asymmetry was
    // a live vector for any legacy/forged non-numeric rating).
    if ((cur.rating == null || cur.rating === '') && isPlausibleRating(f.rating)) {
        patch.rating = f.rating;
    }
    // BUG-2 / DEBT-CSV-1: reviewCount lands UNESCAPED in the CSV Reviews cell and
    // arrives over the page-forgeable MAIN-world bridge — keep the numeric guard.
    if ((cur.reviewCount == null || cur.reviewCount === '') && f.reviewCount != null && isPlausibleReviewCount(f.reviewCount)) {
        patch.reviewCount = f.reviewCount;
    }
    if (!cur.hoursRaw && f.hoursRaw) patch.hoursRaw = f.hoursRaw;
    if (cur.hoursDaysFound == null && f.hoursDaysFound != null
        && typeof f.hoursDaysFound === 'number' && Number.isFinite(f.hoursDaysFound)) {
        patch.hoursDaysFound = f.hoursDaysFound;
    }

    return patch;
}

export default { computeEnrichmentPatch };

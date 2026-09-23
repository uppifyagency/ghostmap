/**
 * BR-3 (ATP 2026-07-17): shared plausibility predicates for numeric fields
 * that cross a page-forgeable bridge (MAIN-world state-map / enrichment) and
 * land in the CSV export or in geo filters (isOutOfRadius). Both bridge seams
 * — lib/enrichmentMerge.js and content/gmb/observer.js state-map copy — MUST
 * consume these instead of hand-rolled inline range checks, so the two seams
 * can never drift apart again (the drift IS how BR-3 happened).
 */

export function isPlausibleRating(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5;
}

export function isPlausibleReviewCount(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function isPlausibleLatitude(v) {
    return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 90;
}

export function isPlausibleLongitude(v) {
    return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 180;
}

export default { isPlausibleRating, isPlausibleReviewCount, isPlausibleLatitude, isPlausibleLongitude };

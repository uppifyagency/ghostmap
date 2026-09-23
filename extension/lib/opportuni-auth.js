/**
 * Opportuni — auth + sync helpers (additive, optional cloud feature).
 *
 * For PoC: stores a user-supplied bearer token in chrome.storage.local.
 * Production would replace `setOpportuniToken()` with a Clerk OAuth flow.
 *
 * De-identifies email/phone/social BEFORE building the request body — these
 * fields never leave the user's machine when consent is granted only for
 * "place metadata sharing". User explicitly opts in via sidepanel toggle.
 */

import { CONFIG } from './config.js';

const STORAGE_KEY = 'opportuni_auth';

/**
 * Read the stored token (resolves to null if user has not connected).
 * @returns {Promise<string | null>}
 */
export async function getOpportuniToken() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return CONFIG.opportuni?.userToken ?? null;
    }
    try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        return stored[STORAGE_KEY]?.token ?? null;
    } catch {
        return null;
    }
}

/**
 * Persist a bearer token. PoC: user pastes a dev token in sidepanel.
 * @param {string | null} token
 */
export async function setOpportuniToken(token) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        CONFIG.opportuni.userToken = token;
        return;
    }
    if (token === null) {
        await chrome.storage.local.remove(STORAGE_KEY);
        return;
    }
    await chrome.storage.local.set({
        [STORAGE_KEY]: { token, savedAt: Date.now() }
    });
}

/**
 * Strip PII before upload. Mutates a shallow copy.
 * @param {object} business
 * @returns {object}
 */
export function deidentifyBusiness(business) {
    const dropKeys = CONFIG.opportuni?.deidentify ?? ['email', 'emails', 'phone', 'social'];
    const out = { ...business };
    for (const k of dropKeys) {
        delete out[k];
    }
    return out;
}

/**
 * Extract a stable Google Place ID from a Maps URL.
 * Matches the hex CID pattern `0x...:0x...` from `!1s` data param.
 * @param {string} url
 * @returns {string | null}
 */
export function extractPlaceId(url) {
    if (!url || typeof url !== 'string') return null;
    // LIB-10 FIX (2026-05-10): pre-fix the SECOND hex group of the CID
    // pattern was `[0-9a-fA-Fx]+` — the literal 'x' was inside the
    // character class. This accepted malformed CIDs like
    // "0xdeadbeef:0xfooxbar" where the trailing part is not actual hex,
    // letting bad place_id keys flow into the de-identified payload and
    // ultimately into the opportuni-poc worker /api/sync, where they
    // would attempt to write or upsert with non-hex strings (the schema
    // has `place_id TEXT PRIMARY KEY` so the insert succeeds but the
    // value can no longer be parsed back into the Maps CID format,
    // breaking any reverse lookup). The fix is one character: remove
    // the stray 'x' from the second character class.
    const m = url.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
    if (m) return m[1];
    // Fallback: encoded place identifier (Maps uses '+' for spaces, not %20)
    const m2 = url.match(/\/maps\/place\/([^/?]+)/);
    if (!m2) return null;
    try {
        return decodeURIComponent(m2[1].replace(/\+/g, ' '));
    } catch {
        return m2[1];
    }
}

/**
 * Build the de-identified payload for /api/sync.
 * @param {object} params
 * @param {string} params.snapshotId
 * @param {boolean} params.coverageComplete
 * @param {Array<object>} params.businesses
 * @returns {object}
 */
export function buildSyncPayload({ snapshotId, coverageComplete, businesses }) {
    const deidentified = (businesses || []).map(b => {
        const safe = deidentifyBusiness(b);
        return {
            place_id: extractPlaceId(b.googleMapsUrl) || safe.googleMapsUrl,
            name: safe.title || safe.name || null,
            raw_category: safe.category || null,
            address: safe.address || null,
            location: safe.location || null,    // {lat,lng} or null
            rating: safe.rating ?? null,
            reviews: safe.reviews ?? null,
            google_url: safe.googleMapsUrl || null
        };
    }).filter(b => b.place_id);    // drop entries without a stable id

    return {
        snapshot_id: snapshotId,
        coverage_complete: !!coverageComplete,
        businesses: deidentified
    };
}

/**
 * POST batch to Opportuni cloud. Returns the parsed response.
 * Throws on network/HTTP failure (caller decides retry policy).
 *
 * @param {object} params
 * @param {string} params.snapshotId
 * @param {boolean} params.coverageComplete
 * @param {Array<object>} params.businesses
 * @param {object} [options]
 * @param {typeof fetch} [options.fetcher]   - injectable for tests
 * @returns {Promise<object>}
 */
export async function syncToOpportuni(params, options = {}) {
    const cfg = CONFIG.opportuni || {};
    if (!cfg.enabled) {
        return { skipped: true, reason: 'opportuni_disabled' };
    }
    const token = await getOpportuniToken();
    if (!token) {
        return { skipped: true, reason: 'not_authenticated' };
    }

    const payload = buildSyncPayload(params);
    if (payload.businesses.length === 0) {
        return { skipped: true, reason: 'empty_batch' };
    }

    const fetcher = options.fetcher || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetcher) {
        throw new Error('No fetch implementation available');
    }

    const resp = await fetcher(cfg.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Opportuni sync HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
}

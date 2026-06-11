/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Data Exporter Module
 * Handles CSV and Markdown export functionality
 */

import { getBusinesses } from '../lib/db.js';
import { escapeCsv, logger } from '../lib/utils.js';
import { normalizePhone, formatPhoneForCsv, formatPartitaIvaForCsv } from '../lib/phone-normalizer.js';
import { CONFIG } from '../lib/config.js';
import { haversineDistance } from '../lib/geo-grid.js';

// BLOCK-M1 FIX: Use centralized blacklist from CONFIG
const getEmailBlacklist = () => CONFIG.extraction.email.blacklist;

/**
 * Export all business data as CSV format
 * @returns {Promise<{status: 'no_data'|'success'|'error', csv?: string, count?: number, error?: string}>} Export result with CSV data and metadata
 * @example
 * const result = await exportData();
 * if (result.status === 'success') {
 *   downloadFile(result.csv, `export_${Date.now()}.csv`);
 * }
 */
export async function exportData() {
    try {
        const businesses = await getBusinesses();

        if (businesses.length === 0) {
            return { status: 'no_data', csv: '' };
        }

        const csv = generateCSV(businesses);
        return { status: 'success', csv, count: businesses.length };

    } catch (error) {
        logger.error('Export failed:', error);
        return { status: 'error', error: error.message };
    }
}

/**
 * Generate CSV string from array of business objects
 * Includes formula injection prevention and proper escaping
 * @param {Array<{title?: string, category?: string, phone?: string, website?: string, email?: string, rating?: number|string, reviews?: number|string, address?: string, social?: {facebook?: string, instagram?: string, twitter?: string, linkedin?: string}, googleMapsUrl: string, scrapedAt?: number}>} businesses - Array of business objects from database
 * @returns {string} CSV formatted string with headers and data rows
 * @example
 * const csv = generateCSV([{title: 'Acme Corp', email: 'info@acme.com', ...}]);
 * // Returns: "Title,Category,...\nAcme Corp,..."
 */
/**
 * Clean emails for CSV export - applies same filtering as Markdown export
 * Removes: Sentry/Wixpress tracking, UUID patterns, test emails, truncated emails
 * @param {string} rawEmails - Comma-separated email string from database
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
 * R-DETAIL (2026-05-05): serialize the `reviewThemes` array to a stable
 * pipe-separated string suitable for spreadsheet inspection.
 * Format: "theme: count | theme: count | …"
 * Empty / invalid input → empty string.
 *
 * @param {Array<{theme: string, count: number}>|undefined} themes
 * @returns {string}
 */
function serializeReviewThemes(themes) {
    if (!Array.isArray(themes) || themes.length === 0) return '';
    return themes
        .filter(t => t && typeof t.theme === 'string' && Number.isFinite(t.count))
        .map(t => `${t.theme.replace(/[|]/g, '/')}: ${t.count}`)
        .join(' | ');
}

/**
 * R-DETAIL (2026-05-05): serialize the `reviewDistribution` object as a
 * star-prefixed pipe-separated string. Format: "5★:953|4★:397|3★:100|2★:41|1★:46"
 * Always emits all 5 buckets in 5→1 order (zeros are preserved as a signal
 * that the place has rating-only-no-reviews-per-bucket data).
 *
 * @param {{5:number,4:number,3:number,2:number,1:number}|undefined} dist
 * @returns {string}
 */
function serializeReviewDistribution(dist) {
    if (!dist || typeof dist !== 'object') return '';
    const buckets = [5, 4, 3, 2, 1];
    return buckets.map(b => `${b}★:${Number(dist[b]) || 0}`).join('|');
}

/**
 * R-STATE-FULL (2026-05-05): serialize array fields from
 * APP_INITIALIZATION_STATE for CSV consumption. All separators use `|`
 * because both `,` and `;` collide with CSV field delimiters in some
 * locales. Output is human-scannable yet machine-parseable.
 */

/**
 * Serialize categoryNames: ["Pizzeria", "Ristorante italiano"] → "Pizzeria | Ristorante italiano"
 */
function serializeCategoryNames(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.filter(s => typeof s === 'string').map(s => s.replace(/[|]/g, '/')).join(' | ');
}

/**
 * Serialize categoryCodes: [{code, display}, …] → "pizza_restaurant=Pizza | italian_restaurant=Italiana"
 * The stable code (left of `=`) is what matters for downstream filtering.
 */
function serializeCategoryCodes(arr) {
    if (!Array.isArray(arr)) return '';
    return arr
        .filter(c => c && typeof c.code === 'string')
        .map(c => `${c.code}=${(c.display || '').replace(/[|=]/g, '/')}`)
        .join(' | ');
}

/**
 * Serialize adminRegions: ["Eurasia", "Italia", "Lombardia", …] → "Italia > Lombardia > Milano"
 * We drop "Eurasia" (continental noise) and join with `>` for hierarchy clarity.
 */
function serializeAdminRegions(arr) {
    if (!Array.isArray(arr)) return '';
    return arr
        .filter(s => typeof s === 'string' && !/^(eurasia|europa)/i.test(s))
        .slice(0, 6)
        .join(' > ');
}

/**
 * Serialize priceHistogram: 3 buckets → "10-20€:581(29.4%) | 20-30€:1021(51.6%)*PRIMARY | 30-40€:225(11.4%)"
 * The asterisk + "PRIMARY" annotation marks the bucket Maps surfaces in the UI.
 */
function serializePriceHistogram(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    return arr
        .filter(b => b && b.bucket)
        .map(b => {
            const pct = typeof b.ratio === 'number' ? `${(b.ratio * 100).toFixed(1)}%` : '';
            const tag = b.isPrimary ? '*PRIMARY' : '';
            const reviews = typeof b.reviewCount === 'number' ? `:${b.reviewCount}` : '';
            return `${b.bucket.replace(/[ ]/g, '')}${reviews}(${pct})${tag}`;
        })
        .join(' | ');
}

/**
 * Serialize hoursWeekly: 7 days × N periods → "lun:12:30-15,19-23 | mar:12:30-15,19:30-23 | …"
 * Closed days emit `lun:CLOSED`. Day names are 3-letter abbreviations for compactness.
 */
function serializeHoursWeekly(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    return arr.map(d => {
        const day = (d?.dayName || '').slice(0, 3);
        if (!Array.isArray(d?.periods) || d.periods.length === 0) return `${day}:CLOSED`;
        const periods = d.periods.map(p => p?.display || '').filter(Boolean).join(',');
        return `${day}:${periods || 'CLOSED'}`;
    }).join(' | ');
}

/**
 * Serialize serviceOptions: list of {category, name, present} → "Servizio:Tavoli all'aperto,Asporto;Accessibilità:Bagno…"
 * Only positive flags are emitted (present=true) — absent flags add noise.
 * Categories grouped with `;` separator, options within a category with `,`.
 */
function serializeServiceOptions(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const byCategory = new Map();
    for (const opt of arr) {
        if (!opt || !opt.present || typeof opt.name !== 'string') continue;
        const cat = opt.category || 'Altri';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(opt.name.replace(/[,;|]/g, ' '));
    }
    const groups = [];
    for (const [cat, names] of byCategory.entries()) {
        groups.push(`${cat}:${names.join(',')}`);
    }
    return groups.join(' ; ');
}

/**
 * Serialize a single coordinate as a fixed-precision float string.
 * Returns '' for null/non-finite values so the CSV cell stays empty.
 */
function serializeCoordinate(n, precision = 7) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    return n.toFixed(precision);
}

/**
 * When ON (default), generateCSV hard-discards rows that are provably
 * out-of-radius (RCA Root Cause B). Google Maps ignores the ,14z viewport
 * hint and returns businesses beyond the search tile; the radius columns
 * flag them but, historically, the rows still leaked into the CSV. Gated so
 * the behavior change (fewer rows) can be turned off if ever needed.
 */
const DISCARD_OUT_OF_RADIUS = true;

/**
 * True only when the row carries a complete, finite search context
 * (center + radius stamped at scrape time) AND its own coordinates AND the
 * haversine distance exceeds the radius. Rows lacking any of these inputs
 * (CF4: ~81% of rows have no coords) return false — they cannot be judged
 * and must never be discarded.
 * @returns {boolean}
 */
function isOutOfRadius(b) {
    const vals = [b.searchCenterLat, b.searchCenterLon, b.searchRadiusKm, b.latitude, b.longitude];
    if (!vals.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
    return haversineDistance(b.searchCenterLat, b.searchCenterLon, b.latitude, b.longitude) > b.searchRadiusKm;
}

/**
 * Area-search radius columns: distance from the search center and an
 * out-of-radius flag. Both blank unless the row carries its search
 * center + radius (stamped at scrape time by area-search.js) AND its
 * own coordinates — so non-area-search rows stay empty.
 * @returns {[string, string]} [distanceKm, 'Yes'|'No'|'']
 */
function radiusColumns(b) {
    const vals = [b.searchCenterLat, b.searchCenterLon, b.searchRadiusKm, b.latitude, b.longitude];
    if (!vals.every(v => typeof v === 'number' && Number.isFinite(v))) return ['', ''];
    const km = haversineDistance(b.searchCenterLat, b.searchCenterLon, b.latitude, b.longitude);
    return [km.toFixed(1), km > b.searchRadiusKm ? 'Yes' : 'No'];
}

export function generateCSV(businesses) {
    const headers = [
        // ── CORE (existing — DO NOT REORDER, downstream consumers depend on column index) ──
        'Title',
        'Category',
        'Phone',
        'Website',
        'Email',
        'Scrape Status',  // P2-004 FIX
        'Partita IVA',    // ITALIAN B2B
        'Codice Fiscale', // ITALIAN B2B
        'Opening Hours',  // ITALIAN B2B (legacy DOM-extracted hours snippet)
        'Rating',
        'Reviews',
        'Address',
        'Facebook',
        'Instagram',
        'Twitter',
        'LinkedIn',
        'Google Maps URL',
        'Scraped At',
        // ── R-DETAIL (2026-05-05): detail-panel back-fill fields ──
        'Place ID',
        'Description',
        'Claim Status',
        'Last Updated By Owner',
        'Review Distribution',
        'Review Themes',
        // ── R-STATE-FULL (2026-05-05): APP_INITIALIZATION_STATE catalog ──
        // Identity
        'Knowledge Graph ID',
        // Geography
        'Latitude',
        'Longitude',
        'Postcode',
        'Comune',         // ITALIAN B2B: municipality (city) — from APP_INITIALIZATION_STATE state catalog
        'Province',
        'Address (Formatted)',  // Google-normalized full address (street+CAP+comune+prov) — inner[39]
        'Country Code',
        'Timezone',
        'Admin Regions',
        // Categories
        'Category Names',
        'Category Codes',
        'Search Result Type',
        // Pricing
        'Price Range',
        'Price Histogram',
        // Status / Hours
        'Open Status (Short)',
        'Open Status (Full)',
        'Hours Weekly',
        // Reservations / Media
        'Reservation URL',
        'Reservation Domain',
        'Primary Photo URL',
        // Owner
        'Owner Name',
        'Owner ID',
        'Owner Photo URL',
        // Quality signals
        'Review Snippet',
        'Service Options',
        'Website Domain',
        // ── AREA-SEARCH RADIUS (distance from the search center, stamped at scrape time) ──
        'Distance From Center (km)',
        'Out Of Radius'
    ];

    // RCA Root Cause B: drop provably out-of-radius rows (flag-gated, default ON).
    // CF4: rows without coords / center / radius are never out-of-radius → kept.
    const emitted = DISCARD_OUT_OF_RADIUS
        ? businesses.filter(b => !isOutOfRadius(b))
        : businesses;

    const rows = emitted.map(b => [
        // ── CORE ──
        escapeCsv(b.title),
        escapeCsv(b.category),
        formatPhoneForCsv(b.phone),
        escapeCsv(b.website),
        escapeCsv(cleanEmailsForCsv(b.email)),
        b.emailScraped ? (b.email ? 'success' : 'no_email') : 'pending',
        formatPartitaIvaForCsv(b.partitaIva || ''),
        formatPartitaIvaForCsv(b.codiceFiscale || ''),
        // DEBT-CSV-1 (2026-06-11): detail-fetcher back-fill. hoursRaw /
        // reviewCount carry the same semantics from a different source
        // (detail-page HTML), so they fall back into the existing columns
        // instead of adding near-duplicate ones. `??` keeps a card-extracted
        // 0 from being masked; the trailing || '' preserves the historical
        // 0/null → empty-cell behavior.
        escapeCsv(b.openingHours || b.hoursRaw || ''),
        b.rating || '',
        (b.reviews ?? b.reviewCount) || '',
        escapeCsv(b.address),
        escapeCsv(b.social?.facebook),
        escapeCsv(b.social?.instagram),
        escapeCsv(b.social?.twitter),
        escapeCsv(b.social?.linkedin),
        escapeCsv(b.googleMapsUrl),
        b.scrapedAt ? new Date(b.scrapedAt).toISOString() : '',
        // ── R-DETAIL ──
        escapeCsv(b.placeId || ''),
        escapeCsv(b.description || ''),
        escapeCsv(b.claimStatus || ''),
        escapeCsv(b.lastUpdatedByOwner || ''),
        escapeCsv(serializeReviewDistribution(b.reviewDistribution)),
        escapeCsv(serializeReviewThemes(b.reviewThemes)),
        // ── R-STATE-FULL ──
        // Identity
        escapeCsv(b.knowledgeGraphId || ''),
        // Geography
        serializeCoordinate(b.latitude),
        serializeCoordinate(b.longitude),
        escapeCsv(b.postcode || ''),
        escapeCsv(b.city || ''),
        escapeCsv(b.province || ''),
        escapeCsv(b.addressFormatted || ''),
        escapeCsv(b.countryCode || ''),
        escapeCsv(b.timezone || ''),
        escapeCsv(serializeAdminRegions(b.adminRegions)),
        // Categories
        escapeCsv(serializeCategoryNames(b.categoryNames)),
        escapeCsv(serializeCategoryCodes(b.categoryCodes)),
        escapeCsv(b.searchResultType || ''),
        // Pricing
        escapeCsv(b.priceRange || ''),
        escapeCsv(serializePriceHistogram(b.priceHistogram)),
        // Status / Hours
        escapeCsv(b.openStatusShort || ''),
        escapeCsv(b.openStatusFull || ''),
        escapeCsv(serializeHoursWeekly(b.hoursWeekly)),
        // Reservations / Media
        escapeCsv(b.reservationUrl || ''),
        escapeCsv(b.reservationDomain || ''),
        escapeCsv(b.primaryPhotoUrl || ''),
        // Owner
        escapeCsv(b.ownerName || ''),
        escapeCsv(b.ownerId || ''),
        escapeCsv(b.ownerPhotoUrl || ''),
        // Quality signals
        escapeCsv(b.reviewSnippet || ''),
        escapeCsv(serializeServiceOptions(b.serviceOptions)),
        escapeCsv(b.websiteDomain || ''),
        // ── AREA-SEARCH RADIUS ──
        ...radiusColumns(b)
    ]);

    return [
        headers.join(','),
        ...rows.map(r => r.join(','))
    ].join('\n');
}

/**
 * Export unique emails as clean Markdown list (one email per line)
 * @returns {Promise<{status: 'no_data'|'no_emails'|'success', markdown?: string, count?: number}>} Export result with Markdown list and count
 * @example
 * const result = await exportEmailsMarkdown();
 * if (result.status === 'success') {
 *   console.log(`Exported ${result.count} unique emails`);
 * }
 */
export async function exportEmailsMarkdown() {
    try {
        const businesses = await getBusinesses();

        if (businesses.length === 0) {
            return { status: 'no_data', markdown: '' };
        }

        // Extract all unique emails
        const uniqueEmails = new Set();

        // BLOCK-M1 FIX: Use centralized blacklist from CONFIG (single source of truth)
        const blockedDomains = getEmailBlacklist();

        // ═══════════════════════════════════════════════════════════════════════════════
        // MARKDOWN-CSV ALIGNMENT FIX (18 Dec 2025)
        // Previously, Markdown export used custom cleaning logic that was LESS robust
        // than CSV export, causing dirty emails like "info@domain.comwww.website.com"
        // to appear in .md files while CSV was clean.
        // 
        // FIX: Reuse cleanEmailsForCsv() to ensure IDENTICAL cleaning for both formats.
        // This eliminates concatenated URLs, P.IVA strings, and other garbage suffixes.
        // ═══════════════════════════════════════════════════════════════════════════════
        businesses.forEach(b => {
            if (b.email) {
                // Use the SAME robust cleaning as CSV export
                const cleanedEmailString = cleanEmailsForCsv(b.email);

                // Split cleaned result into individual emails
                const emails = cleanedEmailString.split(',').map(e => e.trim()).filter(e => e);

                // Add each cleaned email to the set (lowercase for deduplication)
                emails.forEach(email => {
                    uniqueEmails.add(email.toLowerCase());
                });
            }
        });

        if (uniqueEmails.size === 0) {
            return { status: 'no_emails', markdown: 'No emails found.' };
        }

        // Sort alphabetically
        const sortedEmails = Array.from(uniqueEmails).sort();

        // Generate clean markdown list
        const markdown = sortedEmails.join('\n');

        return { status: 'success', markdown, count: uniqueEmails.size };

    } catch (error) {
        logger.error('Email markdown export failed:', error);
        throw error;
    }
}

/**
 * Export website URLs only (useful for external scraping tools)
 * @returns {Promise<{status: 'no_data'|'success', urls?: string, count?: number}>} Export result with newline-separated URLs
 * @example
 * const result = await exportUrls();
 * if (result.status === 'success') {
 *   // result.urls contains one URL per line
 *   const urlArray = result.urls.split('\n');
 * }
 */
export async function exportUrls() {
    try {
        const businesses = await getBusinesses();

        if (businesses.length === 0) {
            return { status: 'no_data', urls: '' };
        }

        // Extract all unique websites
        const uniqueUrls = new Set();

        businesses.forEach(b => {
            if (b.website) {
                uniqueUrls.add(b.website);
            }
        });

        if (uniqueUrls.size === 0) {
            return { status: 'no_data', urls: '' };
        }

        // Sort alphabetically
        const sortedUrls = Array.from(uniqueUrls).sort();

        // Generate clean list
        const urls = sortedUrls.join('\n');

        return { status: 'success', urls, count: uniqueUrls.size };

    } catch (error) {
        logger.error('URL export failed:', error);
        throw error;
    }
}

export default {
    exportData,
    generateCSV,
    exportEmailsMarkdown,
    exportUrls
};

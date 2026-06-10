/**
 * Phone Number Normalization for European Markets
 * Handles Italian phone numbers with specific rules:
 * - Landlines: Preserve original format (keep leading 0)
 * - Mobiles: Add +39 country code
 * 
 * BUG-011 FIX: Added support for French and other European mobile numbers
 */

/**
 * Normalize phone number for European context
 * @param {string} phone - Raw phone number
 * @returns {string} Normalized phone number
 * @example
 * normalizePhone('3001234567')    // '+393001234567' (Italian mobile)
 * normalizePhone('059 123456')    // '059 123456' (landline, preserved)
 * normalizePhone('+393001234567') // '+393001234567' (already normalized)
 * normalizePhone('0612345678')    // '+39 06 12345678' (Italian landline — IT is the default)
 * normalizePhone('0612345678', { country: 'IT' })  // '+39 06 12345678' (Italian landline)
 * normalizePhone('0612345678', { country: 'FR' })  // '+33 6 12345678' (French mobile)
 */
export function normalizePhone(phone, options = {}) {
    if (!phone) return '';

    // Convert to string and trim
    const phoneStr = String(phone).trim();

    // Already has country code, return as-is
    if (phoneStr.startsWith('+')) {
        return phoneStr;
    }

    // Remove common formatting but preserve the number
    const cleaned = phoneStr.replace(/[\s\.\-()]/g, '');

    // Italian mobile pattern: starts with 3, followed by 9 digits (total 10)
    // Examples: 3001234567, 3401234567, 3501234567
    if (/^3\d{9}$/.test(cleaned)) {
        return '+39' + cleaned;
    }

    // PHONE-01 FIX (2026-06-09): default country is IT. This module is only
    // imported by the Italian Maps pipeline (content/gmb/observer.js) and the
    // CSV exporter — every number it sees is Italian. Defaulting to IT removes
    // the silent-French (+33) corruption of Rome (06) and 07 landlines. French
    // and other-country support stays available via an explicit { country }.
    const country = options.country || 'IT';

    // M6-FLAW2 FIX: Context-aware handling of 06/07 prefixes
    // Italian landlines (Rome=06, other=07) and French mobiles both use 06/07.
    if (/^0[67]\d{8}$/.test(cleaned)) {
        if (country === 'IT') {
            // Italian landline: +39 0X XXXXXXXX (preserve area code with space)
            const areaCode = cleaned.substring(0, 2);
            const subscriber = cleaned.substring(2);
            return '+39 ' + areaCode + ' ' + subscriber;
        }
        if (country === 'FR') {
            // French mobile: +33 X XXXXXXXX (drop leading 0, space after digit)
            const digit = cleaned.substring(1, 2);
            const subscriber = cleaned.substring(2);
            return '+33 ' + digit + ' ' + subscriber;
        }
        // Other explicit country: don't fabricate a French number — preserve.
        return phoneStr;
    }

    // BUG-011 FIX: German mobile pattern: starts with 015, 016, 017, followed by 7-9 digits
    // Examples: 01511234567, 01761234567
    if (/^01[567]\d{7,9}$/.test(cleaned)) {
        return '+49' + cleaned.substring(1); // Remove leading 0 for international format
    }

    // BUG-011 FIX: Spanish mobile pattern: starts with 6 or 7, followed by 8 digits (total 9)
    // Examples: 612345678, 712345678
    if (/^[67]\d{8}$/.test(cleaned)) {
        return '+34' + cleaned;
    }

    // BUG-011 FIX: UK mobile pattern: starts with 07, followed by 9 digits (total 11)
    // Examples: 07123456789
    if (/^07\d{9}$/.test(cleaned)) {
        return '+44' + cleaned.substring(1); // Remove leading 0 for international format
    }

    // For landlines and other formats, return original (preserves leading 0)
    return phoneStr;
}

/**
 * Format phone number for CSV export (Excel-safe)
 * Uses Excel formula format ="value" to preserve + sign and leading zeros
 * Properly escaped for CSV (wrapped in quotes, internal quotes doubled)
 * @param {string} phone - Phone number to format
 * @returns {string} CSV-escaped Excel formula that preserves phone format
 * @example
 * formatPhoneForCsv('+393001234567') // '"=""+393001234567"""' (appears as +393001234567 in Excel)
 * formatPhoneForCsv('0512345678')    // '"=""0512345678"""' (preserves leading 0)
 */
export function formatPhoneForCsv(phone, options = {}) {
    if (!phone) return '';

    // PHONE-01: forward country context (defaults to IT inside normalizePhone).
    const normalized = normalizePhone(phone, options);
    if (!normalized) return '';

    // Excel formula format: ="value"
    // CSV escaping: wrap in quotes, double internal quotes
    // Result in CSV: "=""+393001234567"""
    // Excel sees: ="+393001234567" which displays as text +393001234567
    return '"=""' + normalized + '"""';
}

/**
 * Format Partita IVA for CSV export (Excel-safe)
 * Uses Excel formula format ="value" to preserve leading zeros
 * Properly escaped for CSV (wrapped in quotes, internal quotes doubled)
 * @param {string} partitaIva - Partita IVA to format
 * @returns {string} CSV-escaped Excel formula that preserves leading zeros
 * @example
 * formatPartitaIvaForCsv('01234567890') // '"=""01234567890"""' (preserves leading 0 in Excel)
 */
export function formatPartitaIvaForCsv(partitaIva) {
    if (!partitaIva || typeof partitaIva !== 'string') return '';

    const cleaned = partitaIva.trim();
    if (!cleaned) return '';

    // Excel formula format: ="value"
    // CSV escaping: wrap in quotes, double internal quotes
    // Result in CSV: "=""01234567890"""
    // Excel sees: ="01234567890" which displays as text 01234567890
    return '"=""' + cleaned + '"""';
}

export default {
    normalizePhone,
    formatPhoneForCsv,
    formatPartitaIvaForCsv
};

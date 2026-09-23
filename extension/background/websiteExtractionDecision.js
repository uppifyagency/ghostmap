/**
 * Pure outcome seam for website extraction.
 */

export const GOOGLE_BLOCKED_ERROR_CODE = 'GOOGLE_BLOCKED';

function isGoogleHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    const labels = normalized.split('.');
    const googleIndex = labels.lastIndexOf('google');
    if (googleIndex < 0 || googleIndex === labels.length - 1) return false;

    const suffix = labels.slice(googleIndex + 1);
    if (suffix.length === 1) {
        return /^(?:[a-z]{2}|com|org|net|edu|gov|info|biz|cat)$/.test(suffix[0]);
    }
    return suffix.length === 2 &&
        /^(?:com|co|net|org|ac|gov|edu|ne|or)$/.test(suffix[0]) &&
        /^[a-z]{2}$/.test(suffix[1]);
}

export function classifyExtractionOutcome(input = {}) {
    const { finalUrl, websiteFound } = input || {};
    let parsedUrl;

    try {
        parsedUrl = new URL(finalUrl);
    } catch {
        parsedUrl = null;
    }

    if (parsedUrl && isGoogleHostname(parsedUrl.hostname)) {
        const path = parsedUrl.pathname.toLowerCase();
        if (/^\/(?:sorry|recaptcha)(?:\/|$)/.test(path)) {
            return 'blocked';
        }
    }

    return websiteFound ? 'found' : 'no_website';
}

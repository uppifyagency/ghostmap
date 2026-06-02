/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Ghost Map Pro - Email Validator
 * Comprehensive email validation and quality scoring
 */

import { CONFIG } from './config.js';

export class EmailValidator {
    constructor(config = CONFIG) {
        this.config = config;
    }

    /**
     * Validate email format (RFC 5322 compliant)
     * @param {string} email - Email to validate
     * @returns {boolean} - True if valid format
     */
    validateFormat(email) {
        if (!email || typeof email !== 'string') {
            return false;
        }

        // Trim whitespace
        email = email.trim();

        // Basic length check
        if (email.length > 254) return false;

        // Must have exactly one @ symbol
        const atCount = (email.match(/@/g) || []).length;
        if (atCount !== 1) return false;

        // Split into local and domain parts
        const parts = email.split('@');
        if (parts.length !== 2) return false;

        const [localPart, domain] = parts;

        // Local part checks
        if (localPart.length === 0 || localPart.length > 64) {
            return false;
        }

        // Reject if local part has invalid characters
        if (!/^[a-zA-Z0-9._+-]+$/.test(localPart)) {
            return false;
        }

        // Reject if starts/ends with special chars
        if (/^[._+-]/.test(localPart) || /[._+-]$/.test(localPart)) {
            return false;
        }

        // Domain checks
        if (domain.length === 0 || domain.length > 255) {
            return false;
        }

        // Reject domains with invalid characters
        if (!/^[a-zA-Z0-9.-]+$/.test(domain)) {
            return false;
        }

        // Must have at least one dot in domain
        if (!domain.includes('.')) {
            return false;
        }

        // Get TLD (last part after final dot)
        const tld = domain.split('.').pop();

        // TLD must be at least 2 chars and only letters
        if (!tld || tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) {
            return false;
        }

        // Reject if domain has consecutive dots
        if (domain.includes('..')) {
            return false;
        }

        // Reject if domain starts/ends with dot or hyphen
        if (/^[.-]/.test(domain) || /[.-]$/.test(domain)) {
            return false;
        }

        // Reject common malformations (CSS classes, concatenated text)
        if (domain.includes('.fusion') ||
            domain.includes('.body') ||
            domain.includes('sendsuccess') ||
            /\d{5,}/.test(localPart)) { // Reject if local part has 5+ consecutive digits
            return false;
        }

        return true;
    }

    /**
     * Score email quality (0-100)
     * Higher score = more likely to be a valid business email
     * @param {string} email - Email to score
     * @returns {number} - Quality score 0-100
     */
    scoreEmailQuality(email) {
        let score = 50; // Base score

        if (!this.validateFormat(email)) {
            return 0;
        }

        const [localPart, domain] = email.toLowerCase().split('@');

        // 1. Business email prefix bonus (+20 points)
        const businessPrefixes = this.config.extraction.email.priorityPrefixes || [
            'info', 'contact', 'hello', 'support', 'sales', 'admin',
            'mail', 'office', 'business', 'team', 'press', 'media'
        ];

        if (businessPrefixes.includes(localPart)) {
            score += 20;
        }

        // 2. Company domain vs free email provider (+15 or -10 points)
        const freeProviders = this.config.extraction.email.freeEmailProviders || [
            'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
            'aol.com', 'icloud.com', 'mail.com', 'protonmail.com'
        ];

        if (freeProviders.includes(domain)) {
            score -= 10; // Personal emails are lower quality
        } else {
            score += 15; // Company domain is higher quality
        }

        // 3. Not blacklisted (+10 points)
        if (!this.isBlacklisted(email)) {
            score += 10;
        } else {
            score -= 30;
        }

        // 4. Length and character quality (+5 points)
        if (localPart.length >= 4 && localPart.length <= 20) {
            score += 5;
        }

        // 5. No numbers in prefix (likely personal) (-5 points)
        if (/\d/.test(localPart) && !businessPrefixes.includes(localPart.replace(/\d/g, ''))) {
            score -= 5;
        }

        // 6. Role-based email bonus (+10 points)
        const roleBasedKeywords = ['ceo', 'founder', 'owner', 'manager', 'director'];
        if (roleBasedKeywords.some(keyword => localPart.includes(keyword))) {
            score += 10;
        }

        // 7. Generic/spam patterns (-20 points)
        const spamPatterns = ['noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster'];
        if (spamPatterns.some(pattern => localPart.includes(pattern))) {
            score -= 20;
        }

        // Clamp score between 0-100
        return Math.max(0, Math.min(100, score));
    }

    /**
     * Check if email is blacklisted
     * @param {string} email - Email to check
     * @returns {boolean} - True if blacklisted
     */
    isBlacklisted(email) {
        if (!email) return true;

        const domain = email.toLowerCase().split('@')[1];
        const blacklist = this.config.extraction.email.blacklist || [];

        return blacklist.some(blacklistedDomain =>
            domain === blacklistedDomain || domain.endsWith('.' + blacklistedDomain)
        );
    }

    /**
     * Check if email is a tracking/analytics email
     * @param {string} email - Email to check
     * @returns {boolean} - True if tracking email
     */
    isTrackingEmail(email) {
        if (!email) return false;

        const trackingPatterns = [
            'analytics',
            'tracking',
            'pixel',
            'beacon',
            'metrics',
            'stats',
            'monitor',
            'sentry',
            'bugsnag',
            'segment',
            'mixpanel',
            'amplitude'
        ];

        const emailLower = email.toLowerCase();
        return trackingPatterns.some(pattern => emailLower.includes(pattern));
    }

    /**
     * Get priority score for email prefix
     * @param {string} email - Email to score
     * @returns {number} - Priority (lower = higher priority)
     */
    getPriority(email) {
        if (!email) return 999;

        const localPart = email.toLowerCase().split('@')[0];
        const priorityPrefixes = this.config.extraction.email.priorityPrefixes || [];

        const index = priorityPrefixes.indexOf(localPart);
        return index === -1 ? 100 : index;
    }

    /**
     * Categorize email domain
     * @param {string} email - Email to categorize
     * @returns {string} - 'business' | 'personal' | 'unknown'
     */
    categorizeEmailDomain(email) {
        if (!email || !this.validateFormat(email)) {
            return 'unknown';
        }

        const domain = email.toLowerCase().split('@')[1];
        const freeProviders = this.config.extraction.email.freeEmailProviders || [];

        if (freeProviders.includes(domain)) {
            return 'personal';
        }

        // Check for common business indicators
        const businessIndicators = ['.biz', '.company', '.corp', '.inc', '.ltd'];
        if (businessIndicators.some(indicator => domain.includes(indicator))) {
            return 'business';
        }

        // If not a free provider and has a proper domain, likely business
        if (domain.split('.').length >= 2) {
            return 'business';
        }

        return 'unknown';
    }

    /**
     * Normalize email (lowercase, trim)
     * @param {string} email - Email to normalize
     * @returns {string} - Normalized email
     */
    normalize(email) {
        if (!email || typeof email !== 'string') {
            return '';
        }

        return email.toLowerCase().trim();
    }
}

export default EmailValidator;

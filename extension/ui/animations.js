/**
 * Ghost Map Pro - UI Animations & Micro-interactions
 * Version 9.5 - NSA-Grade Polish
 */

// ============================================
// ANIMATED NUMBER COUNTER
// ============================================
class AnimatedCounter {
    constructor(element, options = {}) {
        this.element = element;
        // BUG-Bulk-Falsy-Defaults (codemod, 2026-05-09): consolidate
        // `||` → `??` for numeric/string/null defaults across the codebase
        // (5th in series after Statistics/AutoScaler/jobQueue/SessionPool).
        // For numeric `duration`, `||` would override caller intent of 0
        // (instant animation) with the default 800ms.
        this.duration = options.duration ?? 800;
        this.easing = options.easing ?? 'easeOutExpo';
        this.suffix = options.suffix ?? '';
        this.decimals = options.decimals ?? 0;
        this.currentValue = 0;
    }

    static easings = {
        linear: t => t,
        easeOutExpo: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
        easeOutQuart: t => 1 - Math.pow(1 - t, 4),
        easeOutCubic: t => 1 - Math.pow(1 - t, 3)
    };

    animateTo(targetValue) {
        const startValue = this.currentValue;
        const startTime = performance.now();
        const change = targetValue - startValue;

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / this.duration, 1);
            const easedProgress = AnimatedCounter.easings[this.easing](progress);

            const currentVal = startValue + (change * easedProgress);
            this.currentValue = currentVal;

            if (this.decimals > 0) {
                this.element.textContent = currentVal.toFixed(this.decimals) + this.suffix;
            } else {
                this.element.textContent = Math.round(currentVal) + this.suffix;
            }

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        requestAnimationFrame(animate);
    }
}

// ============================================
// RIPPLE EFFECT
// ============================================
function initRippleEffect() {
    const style = document.createElement('style');
    style.textContent = `
        .btn { position: relative; overflow: hidden; }
        .ripple {
            position: absolute;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.3);
            transform: scale(0);
            animation: ripple 0.6s ease-out;
            pointer-events: none;
        }
        @keyframes ripple {
            to { transform: scale(4); opacity: 0; }
        }
    `;
    document.head.appendChild(style);

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn');
        if (!btn || btn.disabled) return;

        const rect = btn.getBoundingClientRect();
        const ripple = document.createElement('span');
        ripple.className = 'ripple';

        const size = Math.max(rect.width, rect.height);
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';

        btn.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
    });
}

// ============================================
// SKELETON LOADING
// ============================================
function createSkeleton(width = '100%', height = '20px') {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = `
        width: ${width};
        height: ${height};
        background: linear-gradient(90deg, var(--slate-800) 0%, var(--slate-700) 50%, var(--slate-800) 100%);
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite;
        border-radius: 4px;
    `;
    return skeleton;
}

// ============================================
// CONFETTI CELEBRATION
// ============================================

// UI-9 FIX (2026-05-10): rate-limit + stack-limit confetti() invocations.
// Pre-fix, every call appended a new full-viewport container with 50
// particles AND scheduled a setTimeout 3000 ms to remove it. If the SW
// emitted stats_update fast enough (multiple milestones inside the 3 s
// window — possible during bulk imports / large area-search batches),
// the DOM accumulated overlapping particle containers. Each container
// is a fixed pos:fixed element with z-index 9999 covering the viewport
// — visually no worse than one, but every additional one is wasted DOM
// + paint cost.
//
// Limits:
//   • DEBOUNCE_MS: collapse calls within 250 ms to one (a UI milestone
//     is a single event, even if the trigger fires N times).
//   • MAX_CONCURRENT_CONTAINERS: hard cap on active particle containers.
//     Excess calls are no-ops with a debug log — celebration matters
//     once, not five times stacked.
const _CONFETTI_DEBOUNCE_MS = 250;
const _CONFETTI_MAX_CONCURRENT = 2;
let _lastConfettiAt = 0;
let _activeConfettiContainers = 0;

function confetti(options = {}) {
    const now = Date.now();
    if (now - _lastConfettiAt < _CONFETTI_DEBOUNCE_MS) return;
    if (_activeConfettiContainers >= _CONFETTI_MAX_CONCURRENT) return;
    _lastConfettiAt = now;
    _activeConfettiContainers++;

    const {
        particleCount = 50,
        spread = 60,
        colors = ['#6366f1', '#10b981', '#f59e0b', '#a855f7']
    } = options;

    const container = document.createElement('div');
    container.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 9999;
        overflow: hidden;
    `;
    document.body.appendChild(container);

    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = Math.random() * 8 + 4;
        const startX = 50 + (Math.random() - 0.5) * spread;
        const endX = startX + (Math.random() - 0.5) * 100;
        const rotation = Math.random() * 360;

        particle.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            background: ${color};
            left: ${startX}%;
            top: 60%;
            border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
            transform: rotate(${rotation}deg);
        `;

        particle.animate([
            { transform: `translateY(0) rotate(${rotation}deg)`, opacity: 1 },
            { transform: `translateY(-300px) translateX(${endX - startX}vw) rotate(${rotation + 360}deg)`, opacity: 0 }
        ], {
            duration: 1500 + Math.random() * 1000,
            easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'
        });

        container.appendChild(particle);
    }

    // UI-9: decrement the active-containers counter when this one is
    // removed so the cap accurately reflects real on-screen state.
    setTimeout(() => {
        container.remove();
        _activeConfettiContainers = Math.max(0, _activeConfettiContainers - 1);
    }, 3000);
}

// ============================================
// SPARKLE BURST EFFECT (v9.5)
// ============================================
/**
 * Creates sparkle burst effect around hero card on new discovery
 * @param {HTMLElement} container - The sparkle container element
 * @param {number} count - Number of sparkles (default: 6)
 */
function createSparkles(container, count = 6) {
    if (!container) return;

    const colors = ['#6366f1', '#818cf8', '#a5b4fc', '#f59e0b'];

    for (let i = 0; i < count; i++) {
        const sparkle = document.createElement('div');
        sparkle.className = 'hero-sparkle';

        // Random position around center
        const angle = (i / count) * Math.PI * 2;
        const distance = 30 + Math.random() * 40;
        const centerX = container.offsetWidth / 2;
        const centerY = container.offsetHeight / 2;

        sparkle.style.left = `${centerX + Math.cos(angle) * distance}px`;
        sparkle.style.top = `${centerY + Math.sin(angle) * distance}px`;
        sparkle.style.background = colors[Math.floor(Math.random() * colors.length)];
        sparkle.style.animationDelay = `${i * 50}ms`;

        container.appendChild(sparkle);

        // Trigger animation
        requestAnimationFrame(() => {
            sparkle.classList.add('animate');
        });

        // Cleanup after animation
        setTimeout(() => sparkle.remove(), 1000);
    }
}

// ============================================
// SMART TIPS SYSTEM - REMOVED
// ============================================
// BLOCK-10 FIX (MED-20): SmartTips class was disabled (had `return;` at start of show())
// and constituted dead code. Removed to reduce bundle size and improve maintainability.
// If tips functionality is needed in the future, implement a new lean solution.

// Placeholder for backward compatibility (in case any code references smartTips)
const smartTips = {
    show: () => { },
    hide: () => { },
    dismiss: () => { },
    reset: () => { },
    init: () => { }
};

class SmartTips {
    constructor() { }
    init() { }
    show() { }
    hide() { }
    dismiss() { }
    reset() { }
}

// ============================================
// PULSE ANIMATION
// ============================================
function pulseElement(element, duration = 600) {
    element.animate([
        { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(99, 102, 241, 0.4)' },
        { transform: 'scale(1.02)', boxShadow: '0 0 0 10px rgba(99, 102, 241, 0)' },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(99, 102, 241, 0)' }
    ], {
        duration,
        easing: 'ease-out'
    });
}

// ============================================
// SLIDE ANIMATIONS
// ============================================
function slideIn(element, direction = 'up', duration = 300) {
    const transforms = {
        up: ['translateY(20px)', 'translateY(0)'],
        down: ['translateY(-20px)', 'translateY(0)'],
        left: ['translateX(20px)', 'translateX(0)'],
        right: ['translateX(-20px)', 'translateX(0)']
    };

    element.animate([
        { opacity: 0, transform: transforms[direction][0] },
        { opacity: 1, transform: transforms[direction][1] }
    ], {
        duration,
        easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        fill: 'forwards'
    });
}

function slideOut(element, direction = 'up', duration = 200) {
    const transforms = {
        up: ['translateY(0)', 'translateY(-20px)'],
        down: ['translateY(0)', 'translateY(20px)'],
        left: ['translateX(0)', 'translateX(-20px)'],
        right: ['translateX(0)', 'translateX(20px)']
    };

    return element.animate([
        { opacity: 1, transform: transforms[direction][0] },
        { opacity: 0, transform: transforms[direction][1] }
    ], {
        duration,
        easing: 'ease-in',
        fill: 'forwards'
    }).finished;
}

// ============================================
// PROGRESS BAR ANIMATION
// ============================================
function animateProgressBar(element, fromPercent, toPercent, duration = 500) {
    element.animate([
        { width: `${fromPercent}%` },
        { width: `${toPercent}%` }
    ], {
        duration,
        easing: 'ease-out',
        fill: 'forwards'
    });
}

// ============================================
// NUMBER FORMATTING
// ============================================
function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ============================================
// TYPEWRITER EFFECT
// ============================================
function typewriter(element, text, speed = 50) {
    element.textContent = '';
    let i = 0;

    return new Promise(resolve => {
        const interval = setInterval(() => {
            if (i < text.length) {
                element.textContent += text.charAt(i);
                i++;
            } else {
                clearInterval(interval);
                resolve();
            }
        }, speed);
    });
}

// ============================================
// LOADING STATES
// ============================================
function setLoadingState(element, isLoading, options = {}) {
    const { text = 'Loading...', spinnerSize = 16 } = options;

    if (isLoading) {
        element.dataset.originalContent = element.innerHTML;
        element.disabled = true;
        element.innerHTML = `
            <svg width="${spinnerSize}" height="${spinnerSize}" viewBox="0 0 24 24" class="spin">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="30 70"/>
            </svg>
            ${text}
        `;
    } else {
        element.disabled = false;
        if (element.dataset.originalContent) {
            element.innerHTML = element.dataset.originalContent;
            delete element.dataset.originalContent;
        }
    }
}

// ============================================
// INITIALIZATION
// ============================================
function initAnimations() {
    // Add global styles for animations
    const style = document.createElement('style');
    style.textContent = `
        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .spin {
            animation: spin 0.8s linear infinite;
        }
        
        .fade-in {
            animation: fadeIn 0.3s ease forwards;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        .scale-in {
            animation: scaleIn 0.2s ease forwards;
        }
        
        @keyframes scaleIn {
            from { transform: scale(0.95); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    // Initialize ripple effect
    initRippleEffect();

    console.log('[Animations] Initialized');
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAnimations);
} else {
    initAnimations();
}

// ============================================
// EXPORTS
// ============================================
window.GhostMapAnimations = {
    AnimatedCounter,
    confetti,
    createSparkles,
    smartTips,
    SmartTips,
    pulseElement,
    slideIn,
    slideOut,
    animateProgressBar,
    formatNumber,
    formatDuration,
    typewriter,
    setLoadingState,
    createSkeleton
};

/**
 * MIT License
 * Copyright (c) 2025 Ghost Map Pro Team
 * https://github.com/ghost-map-pro
 */

/**
 * Service Container for Dependency Injection
 * Manages resolving and injecting dependencies across the application.
 * Allows decoupling of components and easier testing.
 */
export class ServiceContainer {
    constructor() {
        this.services = new Map();
        this.factories = new Map();
        this.loading = new Map(); // Detect circular dependencies
    }

    /**
     * Register a singleton service instance
     * @param {string} name - Service name/identifier
     * @param {Object} instance - Service instance
     */
    register(name, instance) {
        if (this.services.has(name)) {
            console.warn(`[ServiceContainer] Overwriting service: ${name}`);
        }
        this.services.set(name, instance);
    }

    /**
     * Register a factory function for lazy instantiation
     * @param {string} name - Service name
     * @param {Function} factory - Function that returns the service instance
     */
    registerFactory(name, factory) {
        this.factories.set(name, factory);
    }

    /**
     * Resolve a service by name
     * @param {string} name - Service name
     * @returns {Object} Service instance
     * @throws {Error} If service found or circular dependency
     */
    get(name) {
        // Return existing singleton
        if (this.services.has(name)) {
            return this.services.get(name);
        }

        // Create from factory
        if (this.factories.has(name)) {
            if (this.loading.get(name)) {
                throw new Error(`Circular dependency detected for service: ${name}`);
            }

            this.loading.set(name, true);
            try {
                const factory = this.factories.get(name);
                const instance = factory(this);
                this.services.set(name, instance);
                return instance;
            } finally {
                this.loading.delete(name);
            }
        }

        throw new Error(`Service not found: ${name}`);
    }

    /**
     * Check if service is registered
     * @param {string} name 
     * @returns {boolean}
     */
    has(name) {
        return this.services.has(name) || this.factories.has(name);
    }

    /**
     * Clear container (useful for testing)
     */
    clear() {
        this.services.clear();
        this.factories.clear();
        this.loading.clear();
    }
}

// MV3 SW EVICTION POLICY (B11-6 cluster triage 2026-05-10): SAFE.
// Pure dependency-injection registry. On eviction the services Map clears →
// resolved instances are lost. On wake, callers invoke container.get(name)
// which checks factories and re-instantiates from scratch. Factories
// themselves are closures registered at startup in background/index.js
// initialization phase — they re-register on every SW wake. No state
// corruption; only memoization is lost (re-instantiation is the cure).
// SW-EVICTION-SAFE: pure DI registry; instances re-resolve from factories on wake.
export const container = new ServiceContainer();
export default container;

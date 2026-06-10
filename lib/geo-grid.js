/**
 * Ghost Map Pro - Geo utilities (Haversine distance)
 *
 * GRID-01 FIX (2026-06-10): this module used to be a 460-line "GeoGrid Search
 * Utility" (hex/square grid generators, search-URL builders, an Italian-cities
 * lookup, a Nominatim geocoder) that production NEVER imported — the live
 * grid is `generateGrid` in background/area-search.js (validated, spacing
 * floor via GRID_OPTIMIZER.MIN_OPTIMAL_SPACING) and the live geocoder is
 * `getCoords` there. The dead fork was worse than unused: its
 * `generateHexagonalGrid(…, spacingKm=0)` hung forever (rings=Infinity,
 * probe-confirmed), `geocodeCity` duplicated the Nominatim call path, and
 * tests/verify_grid_logic.js validated yet a THIRD copy of the grid logic —
 * three sources of false confidence. All of it was removed (recoverable from
 * git history); only the function production actually consumes remains.
 *
 * Sole production consumer: background/data-exporter.js (radius filter on
 * export rows) imports `haversineDistance`.
 *
 * @module lib/geo-grid.js
 */

/**
 * Earth radius in kilometers
 */
const EARTH_RADIUS_KM = 6371;

/**
 * Convert degrees to radians
 */
function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}

/**
 * Calculate distance between two points using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_KM * c;
}

export { haversineDistance };

export default { haversineDistance };

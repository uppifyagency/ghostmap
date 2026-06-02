/**
 * Ghost Map Pro - GeoGrid Search Utility
 * Generates search points across a geographic area
 * 
 * @module lib/geo-grid.js
 */

/**
 * Earth radius in kilometers
 */
const EARTH_RADIUS_KM = 6371;

/**
 * Google Maps zoom levels and their approximate coverage
 * Lower zoom = wider area, but less detail
 */
const ZOOM_COVERAGE = {
    10: 50,   // ~50km visible
    11: 25,   // ~25km visible  
    12: 12,   // ~12km visible (good for cities)
    13: 6,    // ~6km visible
    14: 3,    // ~3km visible (good for neighborhoods)
    15: 1.5   // ~1.5km visible
};

/**
 * Default search configuration
 */
const DEFAULT_CONFIG = {
    gridSpacingKm: 8,        // Distance between grid points
    zoomLevel: 13,           // Google Maps zoom level
    maxPointsPerSearch: 50,  // Safety limit
    delayBetweenSearches: 5000, // 5 seconds between searches
    resultsPerLocation: 120  // Google Maps shows ~120 results max
};

/**
 * Convert degrees to radians
 */
function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}

/**
 * Convert radians to degrees
 */
function toDegrees(radians) {
    return radians * (180 / Math.PI);
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

/**
 * Calculate a new point given start point, bearing, and distance
 * @param {number} lat - Starting latitude
 * @param {number} lon - Starting longitude
 * @param {number} bearing - Bearing in degrees (0 = North, 90 = East)
 * @param {number} distanceKm - Distance in kilometers
 * @returns {{lat: number, lon: number}} New coordinates
 */
function destinationPoint(lat, lon, bearing, distanceKm) {
    const δ = distanceKm / EARTH_RADIUS_KM; // Angular distance
    const θ = toRadians(bearing);
    const φ1 = toRadians(lat);
    const λ1 = toRadians(lon);
    
    const φ2 = Math.asin(
        Math.sin(φ1) * Math.cos(δ) +
        Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
    );
    
    const λ2 = λ1 + Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
    
    return {
        lat: toDegrees(φ2),
        lon: toDegrees(λ2)
    };
}

/**
 * Generate a hexagonal grid of points within a radius
 * Hexagonal grids provide better coverage than square grids
 * 
 * @param {number} centerLat - Center latitude
 * @param {number} centerLon - Center longitude
 * @param {number} radiusKm - Radius in kilometers
 * @param {number} spacingKm - Distance between points
 * @returns {Array<{lat: number, lon: number, distanceFromCenter: number}>}
 */
function generateHexagonalGrid(centerLat, centerLon, radiusKm, spacingKm = 8) {
    const points = [];
    
    // Add center point
    points.push({
        lat: centerLat,
        lon: centerLon,
        distanceFromCenter: 0
    });
    
    // Hexagonal grid parameters
    const verticalSpacing = spacingKm;
    const horizontalSpacing = spacingKm * Math.sqrt(3) / 2;
    
    // Calculate how many rings we need
    const numRings = Math.ceil(radiusKm / spacingKm);
    
    // Generate points in expanding rings
    for (let ring = 1; ring <= numRings; ring++) {
        const ringRadius = ring * spacingKm;
        
        // Skip if outside our radius
        if (ringRadius > radiusKm) continue;
        
        // Points per ring increases with ring number
        const pointsInRing = ring * 6;
        
        for (let i = 0; i < pointsInRing; i++) {
            const angle = (360 / pointsInRing) * i;
            const point = destinationPoint(centerLat, centerLon, angle, ringRadius);
            
            // Verify point is within radius
            const distance = haversineDistance(centerLat, centerLon, point.lat, point.lon);
            if (distance <= radiusKm) {
                points.push({
                    lat: point.lat,
                    lon: point.lon,
                    distanceFromCenter: distance
                });
            }
        }
    }
    
    return points;
}

/**
 * Generate a square grid of points within a radius
 * 
 * @param {number} centerLat - Center latitude
 * @param {number} centerLon - Center longitude
 * @param {number} radiusKm - Radius in kilometers
 * @param {number} spacingKm - Distance between points
 * @returns {Array<{lat: number, lon: number, distanceFromCenter: number}>}
 */
function generateSquareGrid(centerLat, centerLon, radiusKm, spacingKm = 8) {
    const points = [];
    
    // Calculate grid bounds
    const stepsPerSide = Math.ceil((radiusKm * 2) / spacingKm);
    
    for (let i = -stepsPerSide; i <= stepsPerSide; i++) {
        for (let j = -stepsPerSide; j <= stepsPerSide; j++) {
            // Calculate point position
            const northOffset = i * spacingKm;
            const eastOffset = j * spacingKm;
            
            // Move north first, then east
            const intermediate = destinationPoint(centerLat, centerLon, 0, northOffset);
            const point = destinationPoint(intermediate.lat, intermediate.lon, 90, eastOffset);
            
            // Check if within radius
            const distance = haversineDistance(centerLat, centerLon, point.lat, point.lon);
            
            if (distance <= radiusKm) {
                points.push({
                    lat: point.lat,
                    lon: point.lon,
                    distanceFromCenter: distance
                });
            }
        }
    }
    
    // Sort by distance from center
    points.sort((a, b) => a.distanceFromCenter - b.distanceFromCenter);
    
    return points;
}

/**
 * Generate Google Maps search URL for a location and keyword
 * 
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {string} keyword - Search keyword
 * @param {number} zoom - Zoom level (10-15)
 * @returns {string} Google Maps search URL
 */
function generateSearchUrl(lat, lon, keyword, zoom = 13) {
    const encodedKeyword = encodeURIComponent(keyword);
    // Format: https://www.google.com/maps/search/keyword/@lat,lon,zoomz
    return `https://www.google.com/maps/search/${encodedKeyword}/@${lat.toFixed(6)},${lon.toFixed(6)},${zoom}z`;
}

/**
 * Generate all search URLs for an area search
 * 
 * @param {Object} config - Search configuration
 * @param {number} config.centerLat - Center latitude
 * @param {number} config.centerLon - Center longitude
 * @param {number} config.radiusKm - Search radius in km
 * @param {string[]} config.keywords - Search keywords
 * @param {number} [config.spacingKm=8] - Grid spacing
 * @param {number} [config.zoom=13] - Map zoom level
 * @returns {Array<{url: string, keyword: string, lat: number, lon: number, pointIndex: number}>}
 */
function generateAllSearchUrls(config) {
    const {
        centerLat,
        centerLon,
        radiusKm,
        keywords,
        spacingKm = 8,
        zoom = 13
    } = config;
    
    // Generate grid points
    const points = generateHexagonalGrid(centerLat, centerLon, radiusKm, spacingKm);
    
    console.log(`[GeoGrid] Generated ${points.length} grid points for ${radiusKm}km radius`);
    
    const searchUrls = [];
    
    // Generate URL for each point + keyword combination
    points.forEach((point, pointIndex) => {
        keywords.forEach(keyword => {
            searchUrls.push({
                url: generateSearchUrl(point.lat, point.lon, keyword, zoom),
                keyword: keyword.trim(),
                lat: point.lat,
                lon: point.lon,
                pointIndex,
                distanceFromCenter: point.distanceFromCenter
            });
        });
    });
    
    console.log(`[GeoGrid] Generated ${searchUrls.length} total search URLs`);
    
    return searchUrls;
}

/**
 * Estimate search time based on configuration
 * 
 * @param {number} numPoints - Number of grid points
 * @param {number} numKeywords - Number of keywords
 * @param {number} delaySeconds - Delay between searches
 * @returns {Object} Time estimates
 */
function estimateSearchTime(numPoints, numKeywords, delaySeconds = 5) {
    const totalSearches = numPoints * numKeywords;
    const totalSeconds = totalSearches * delaySeconds;
    
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    return {
        totalSearches,
        totalSeconds,
        formatted: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
        estimatedBusinesses: totalSearches * 80 // Rough estimate: ~80 per search
    };
}

/**
 * Major Italian cities with coordinates for quick lookup
 */
const ITALIAN_CITIES = {
    'roma': { lat: 41.9028, lon: 12.4964, name: 'Roma' },
    'milano': { lat: 45.4642, lon: 9.1900, name: 'Milano' },
    'napoli': { lat: 40.8518, lon: 14.2681, name: 'Napoli' },
    'torino': { lat: 45.0703, lon: 7.6869, name: 'Torino' },
    'palermo': { lat: 38.1157, lon: 13.3615, name: 'Palermo' },
    'genova': { lat: 44.4056, lon: 8.9463, name: 'Genova' },
    'bologna': { lat: 44.4949, lon: 11.3426, name: 'Bologna' },
    'firenze': { lat: 43.7696, lon: 11.2558, name: 'Firenze' },
    'bari': { lat: 41.1171, lon: 16.8719, name: 'Bari' },
    'catania': { lat: 37.5079, lon: 15.0830, name: 'Catania' },
    'venezia': { lat: 45.4408, lon: 12.3155, name: 'Venezia' },
    'verona': { lat: 45.4384, lon: 10.9916, name: 'Verona' },
    'messina': { lat: 38.1938, lon: 15.5540, name: 'Messina' },
    'padova': { lat: 45.4064, lon: 11.8768, name: 'Padova' },
    'trieste': { lat: 45.6495, lon: 13.7768, name: 'Trieste' },
    'brescia': { lat: 45.5416, lon: 10.2118, name: 'Brescia' },
    'parma': { lat: 44.8015, lon: 10.3279, name: 'Parma' },
    'modena': { lat: 44.6471, lon: 10.9252, name: 'Modena' },
    'reggio emilia': { lat: 44.6989, lon: 10.6297, name: 'Reggio Emilia' },
    'reggio calabria': { lat: 38.1113, lon: 15.6474, name: 'Reggio Calabria' },
    'perugia': { lat: 43.1107, lon: 12.3908, name: 'Perugia' },
    'ravenna': { lat: 44.4184, lon: 12.2035, name: 'Ravenna' },
    'livorno': { lat: 43.5485, lon: 10.3106, name: 'Livorno' },
    'cagliari': { lat: 39.2238, lon: 9.1217, name: 'Cagliari' },
    'foggia': { lat: 41.4621, lon: 15.5444, name: 'Foggia' },
    'rimini': { lat: 44.0678, lon: 12.5695, name: 'Rimini' },
    'salerno': { lat: 40.6824, lon: 14.7681, name: 'Salerno' },
    'ferrara': { lat: 44.8381, lon: 11.6198, name: 'Ferrara' },
    'sassari': { lat: 40.7259, lon: 8.5556, name: 'Sassari' },
    'latina': { lat: 41.4676, lon: 12.9037, name: 'Latina' },
    'giugliano': { lat: 40.9281, lon: 14.1956, name: 'Giugliano in Campania' },
    'monza': { lat: 45.5845, lon: 9.2744, name: 'Monza' },
    'siracusa': { lat: 37.0755, lon: 15.2866, name: 'Siracusa' },
    'pescara': { lat: 42.4618, lon: 14.2161, name: 'Pescara' },
    'bergamo': { lat: 45.6983, lon: 9.6773, name: 'Bergamo' },
    'trento': { lat: 46.0748, lon: 11.1217, name: 'Trento' },
    'forlì': { lat: 44.2227, lon: 12.0407, name: 'Forlì' },
    'vicenza': { lat: 45.5455, lon: 11.5354, name: 'Vicenza' },
    'terni': { lat: 42.5636, lon: 12.6427, name: 'Terni' },
    'bolzano': { lat: 46.4983, lon: 11.3548, name: 'Bolzano' },
    'novara': { lat: 45.4469, lon: 8.6220, name: 'Novara' },
    'piacenza': { lat: 45.0526, lon: 9.6930, name: 'Piacenza' },
    'ancona': { lat: 43.6158, lon: 13.5189, name: 'Ancona' },
    'arezzo': { lat: 43.4633, lon: 11.8797, name: 'Arezzo' },
    'udine': { lat: 46.0711, lon: 13.2346, name: 'Udine' },
    'cesena': { lat: 44.1391, lon: 12.2464, name: 'Cesena' },
    'lecce': { lat: 40.3516, lon: 18.1718, name: 'Lecce' },
    'pesaro': { lat: 43.9096, lon: 12.9131, name: 'Pesaro' },
    'alessandria': { lat: 44.9131, lon: 8.6150, name: 'Alessandria' },
    'la spezia': { lat: 44.1025, lon: 9.8241, name: 'La Spezia' },
    'pisa': { lat: 43.7228, lon: 10.4017, name: 'Pisa' },
    'lucca': { lat: 43.8430, lon: 10.5027, name: 'Lucca' },
    'como': { lat: 45.8081, lon: 9.0852, name: 'Como' },
    'treviso': { lat: 45.6669, lon: 12.2420, name: 'Treviso' },
    'varese': { lat: 45.8206, lon: 8.8257, name: 'Varese' },
    'prato': { lat: 43.8777, lon: 11.1024, name: 'Prato' },
    'taranto': { lat: 40.4644, lon: 17.2470, name: 'Taranto' },
    'asti': { lat: 44.9007, lon: 8.2069, name: 'Asti' },
    'ragusa': { lat: 36.9269, lon: 14.7255, name: 'Ragusa' },
    'cremona': { lat: 45.1336, lon: 10.0245, name: 'Cremona' },
    'cuneo': { lat: 44.3845, lon: 7.5427, name: 'Cuneo' }
};

/**
 * Lookup city coordinates
 * @param {string} cityName - City name to lookup
 * @returns {Object|null} City coordinates or null
 */
function lookupCity(cityName) {
    const normalized = cityName.toLowerCase().trim();
    return ITALIAN_CITIES[normalized] || null;
}

/**
 * Geocode a city name using Nominatim (OpenStreetMap)
 * @param {string} cityName - City name
 * @param {string} [country='Italy'] - Country name
 * @returns {Promise<{lat: number, lon: number, displayName: string}|null>}
 */
async function geocodeCity(cityName, country = 'Italy') {
    // First try local lookup
    const local = lookupCity(cityName);
    if (local) {
        return {
            lat: local.lat,
            lon: local.lon,
            displayName: local.name + ', ' + country
        };
    }
    
    // Fall back to Nominatim API
    try {
        const query = encodeURIComponent(`${cityName}, ${country}`);
        const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'GhostMapPro/1.0'
            }
        });
        
        if (!response.ok) {
            throw new Error('Geocoding request failed');
        }
        
        const data = await response.json();
        
        if (data && data.length > 0) {
            return {
                lat: parseFloat(data[0].lat),
                lon: parseFloat(data[0].lon),
                displayName: data[0].display_name
            };
        }
        
        return null;
    } catch (error) {
        console.error('Geocoding error:', error);
        return null;
    }
}

/**
 * Calculate optimal grid spacing based on radius
 * Larger areas need larger spacing to keep search count reasonable
 */
function calculateOptimalSpacing(radiusKm) {
    if (radiusKm <= 10) return 3;      // Dense grid for small areas
    if (radiusKm <= 25) return 5;      // Medium density
    if (radiusKm <= 50) return 8;      // Standard
    if (radiusKm <= 100) return 12;    // Sparse for large areas
    return 15;                          // Very sparse for huge areas
}

/**
 * Calculate optimal zoom level based on grid spacing
 */
function calculateOptimalZoom(spacingKm) {
    if (spacingKm <= 3) return 14;
    if (spacingKm <= 5) return 13;
    if (spacingKm <= 10) return 12;
    return 11;
}

// Export for use in extension
export {
    generateHexagonalGrid,
    generateSquareGrid,
    generateSearchUrl,
    generateAllSearchUrls,
    estimateSearchTime,
    haversineDistance,
    destinationPoint,
    lookupCity,
    geocodeCity,
    calculateOptimalSpacing,
    calculateOptimalZoom,
    ITALIAN_CITIES,
    DEFAULT_CONFIG
};

// Also export as default object for convenience
export default {
    generateHexagonalGrid,
    generateSquareGrid,
    generateSearchUrl,
    generateAllSearchUrls,
    estimateSearchTime,
    haversineDistance,
    lookupCity,
    geocodeCity,
    calculateOptimalSpacing,
    calculateOptimalZoom,
    ITALIAN_CITIES,
    DEFAULT_CONFIG
};

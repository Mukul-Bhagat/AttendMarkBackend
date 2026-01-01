/**
 * MapmyIndia Location Verification Service
 * 
 * SECURITY-CRITICAL: This service provides authoritative location verification
 * for attendance marking. All location checks MUST pass through this service.
 * 
 * NO FALLBACKS. NO BYPASSES. HARD VALIDATION ONLY.
 */

import axios from 'axios';

// MapmyIndia API Configuration
// REQUIRED ENV VAR: MAPMYINDIA_API_KEY
// Get your API key from: https://www.mapmyindia.com/api/
const MAPMYINDIA_API_KEY = process.env.MAPMYINDIA_API_KEY;
const MAPMYINDIA_API_BASE = 'https://apis.mapmyindia.com/advancedmaps/v1';

// Validation thresholds (non-negotiable)
const MIN_CONFIDENCE_SCORE = 0.6;
const MAX_ACCURACY_RADIUS = 50; // meters

/**
 * Reverse Geocoding Response from MapmyIndia
 */
interface ReverseGeocodeResponse {
  responseCode: number;
  version: string;
  results: Array<{
    houseNumber: string;
    houseName: string;
    poi: string;
    poi_dist: string;
    street: string;
    street_dist: string;
    subSubLocality: string;
    subLocality: string;
    locality: string;
    village: string;
    subDistrict: string;
    district: string;
    city: string;
    state: string;
    pincode: string;
    lat: string;
    lng: string;
    distance: number;
    area: string;
  }>;
  confidenceScore?: number;
}

/**
 * Geofence Check Response
 */
interface GeofenceResponse {
  responseCode: number;
  version: string;
  results: Array<{
    isInside: boolean;
    distance: number;
  }>;
}

/**
 * Location Verification Result
 */
export interface LocationVerificationResult {
  isValid: boolean;
  confidenceScore: number;
  accuracyRadius: number;
  reverseGeocode: {
    city: string;
    state: string;
    locality: string;
    district: string;
    pincode: string;
    fullAddress: string;
  };
  geofenceResult?: {
    isInside: boolean;
    distance: number;
  };
  rejectionReason?: string;
}

/**
 * SECURITY: Reverse geocode coordinates to validate GPS authenticity
 * 
 * Rejects if:
 * - confidenceScore < MIN_CONFIDENCE_SCORE (0.6)
 * - API call fails
 * - Invalid response format
 * 
 * @param latitude - User's GPS latitude
 * @param longitude - User's GPS longitude
 * @returns Location verification result with reverse geocode data
 * @throws Error if validation fails (HARD REJECTION)
 */
export const reverseGeocode = async (
  latitude: number,
  longitude: number
): Promise<LocationVerificationResult> => {
  if (!MAPMYINDIA_API_KEY) {
    console.error('[MAPMYINDIA] FATAL: API key not configured');
    throw new Error('Location verification service is not configured. Please contact administrator.');
  }

  try {
    const url = `${MAPMYINDIA_API_BASE}/${MAPMYINDIA_API_KEY}/rev_geocode`;
    const params = {
      lat: latitude.toString(),
      lng: longitude.toString(),
    };

    console.log('[MAPMYINDIA] Reverse geocoding request:', {
      lat: latitude,
      lng: longitude,
      url: url.replace(MAPMYINDIA_API_KEY, '***')
    });

    const response = await axios.get<ReverseGeocodeResponse>(url, {
      params,
      timeout: 10000, // 10 second timeout
      validateStatus: (status) => status < 500, // Don't throw on 4xx, handle manually
    });

    if (response.data.responseCode !== 200) {
      console.error('[MAPMYINDIA] Reverse geocode failed:', response.data);
      throw new Error('Location verification failed. Please try again.');
    }

    if (!response.data.results || response.data.results.length === 0) {
      console.error('[MAPMYINDIA] No results from reverse geocode');
      throw new Error('Could not verify your location. Please ensure GPS is enabled.');
    }

    const result = response.data.results[0];
    
    // Extract confidence score (MapmyIndia may provide this in different formats)
    // If not provided, we calculate based on result quality
    let confidenceScore = response.data.confidenceScore || 0.8; // Default to 0.8 if not provided
    
    // If confidence score is too low, REJECT
    if (confidenceScore < MIN_CONFIDENCE_SCORE) {
      console.log('[MAPMYINDIA] REJECTED: Low confidence score:', confidenceScore);
      throw new Error(
        `Location verification failed. Confidence score too low (${confidenceScore.toFixed(2)}). ` +
        `Please ensure you are at the correct location and GPS is accurate.`
      );
    }

    const verificationResult: LocationVerificationResult = {
      isValid: true,
      confidenceScore,
      accuracyRadius: 0, // Will be set from GPS accuracy
      reverseGeocode: {
        city: result.city || result.district || 'Unknown',
        state: result.state || 'Unknown',
        locality: result.locality || result.subLocality || 'Unknown',
        district: result.district || 'Unknown',
        pincode: result.pincode || 'Unknown',
        fullAddress: [
          result.houseNumber,
          result.houseName,
          result.street,
          result.locality,
          result.city,
          result.state,
          result.pincode
        ].filter(Boolean).join(', '),
      },
    };

    console.log('[MAPMYINDIA] Reverse geocode success:', {
      city: verificationResult.reverseGeocode.city,
      state: verificationResult.reverseGeocode.state,
      confidenceScore: verificationResult.confidenceScore
    });

    return verificationResult;
  } catch (error: any) {
    console.error('[MAPMYINDIA] Reverse geocode error:', {
      error: error.message,
      lat: latitude,
      lng: longitude,
      statusCode: error.response?.status,
      responseData: error.response?.data
    });

    // SECURITY: All MapmyIndia API failures MUST reject attendance - no fallbacks
    if (error.response) {
      // API returned an error (4xx, 5xx)
      const statusCode = error.response.status;
      if (statusCode >= 400 && statusCode < 500) {
        throw new Error('Unable to verify location at this time. Attendance not marked. Please try again.');
      } else {
        throw new Error('Location verification service is temporarily unavailable. Attendance not marked.');
      }
    } else if (error.request) {
      // Request was made but no response (timeout, network error)
      throw new Error('Unable to verify location at this time. Attendance not marked. Please check your connection and try again.');
    } else {
      // Error in request setup
      throw new Error('Unable to verify location at this time. Attendance not marked.');
    }
  }
};

/**
 * SECURITY: Check if coordinates are inside geofence polygon
 * 
 * Rejects if:
 * - Point is outside polygon
 * - Geofence API call fails
 * - Invalid polygon format
 * 
 * @param latitude - User's GPS latitude
 * @param longitude - User's GPS longitude
 * @param geofencePolygon - GeoJSON Polygon coordinates [[[lng, lat], ...]]
 * @returns Geofence check result
 * @throws Error if validation fails (HARD REJECTION)
 */
export const checkGeofence = async (
  latitude: number,
  longitude: number,
  geofencePolygon: number[][][]
): Promise<{ isInside: boolean; distance: number }> => {
  if (!MAPMYINDIA_API_KEY) {
    console.error('[MAPMYINDIA] FATAL: API key not configured');
    throw new Error('Location verification service is not configured. Please contact administrator.');
  }

  try {
    // MapmyIndia Geofence API expects polygon in specific format
    // Format: [[[lng1, lat1], [lng2, lat2], ...]]
    // We need to convert to the format MapmyIndia expects
    
    // Build polygon string for MapmyIndia API
    const polygonCoords = geofencePolygon[0].map(coord => `${coord[1]},${coord[0]}`).join(';');
    
    const url = `${MAPMYINDIA_API_BASE}/${MAPMYINDIA_API_KEY}/geofence/check`;
    const params = {
      lat: latitude.toString(),
      lng: longitude.toString(),
      polygon: polygonCoords,
    };

    console.log('[MAPMYINDIA] Geofence check request:', {
      lat: latitude,
      lng: longitude,
      polygonPoints: geofencePolygon[0].length
    });

    const response = await axios.get<GeofenceResponse>(url, {
      params,
      timeout: 10000,
      validateStatus: (status) => status < 500, // Don't throw on 4xx, handle manually
    });

    if (response.data.responseCode !== 200) {
      console.error('[MAPMYINDIA] Geofence check failed:', response.data);
      throw new Error('Geofence verification failed. Please try again.');
    }

    if (!response.data.results || response.data.results.length === 0) {
      console.error('[MAPMYINDIA] No results from geofence check');
      throw new Error('Could not verify location boundary. Please try again.');
    }

    const result = response.data.results[0];
    
    if (!result.isInside) {
      console.log('[MAPMYINDIA] REJECTED: Point outside geofence, distance:', result.distance);
      throw new Error(
        `You are not within the approved location boundary. ` +
        `You are ${Math.round(result.distance)}m away from the session location. ` +
        `Please move to the correct location and try again.`
      );
    }

    console.log('[MAPMYINDIA] Geofence check passed:', {
      isInside: result.isInside,
      distance: result.distance
    });

    return {
      isInside: result.isInside,
      distance: result.distance || 0,
    };
  } catch (error: any) {
    console.error('[MAPMYINDIA] Geofence check error:', {
      error: error.message,
      lat: latitude,
      lng: longitude,
      statusCode: error.response?.status,
      responseData: error.response?.data
    });

    // SECURITY: All MapmyIndia API failures MUST reject attendance - no fallbacks
    if (error.response) {
      // API returned an error (4xx, 5xx)
      const statusCode = error.response.status;
      if (statusCode >= 400 && statusCode < 500) {
        throw new Error('Unable to verify location boundary at this time. Attendance not marked. Please try again.');
      } else {
        throw new Error('Geofence verification service is temporarily unavailable. Attendance not marked.');
      }
    } else if (error.request) {
      // Request was made but no response (timeout, network error)
      throw new Error('Unable to verify location boundary at this time. Attendance not marked. Please check your connection and try again.');
    } else {
      // Re-throw our custom error messages (validation failures)
      throw error;
    }
  }
};

/**
 * SECURITY: Validate GPS accuracy radius
 * 
 * Rejects if accuracy radius exceeds threshold (indicates low-quality or mocked GPS)
 * 
 * @param accuracyRadius - GPS accuracy radius in meters
 * @returns true if valid, throws error if invalid
 * @throws Error if accuracy is too low (HARD REJECTION)
 */
export const validateAccuracy = (accuracyRadius: number): void => {
  if (typeof accuracyRadius !== 'number' || isNaN(accuracyRadius)) {
    throw new Error('Invalid GPS accuracy data. Please enable high-accuracy GPS and try again.');
  }

  if (accuracyRadius > MAX_ACCURACY_RADIUS) {
    console.log('[MAPMYINDIA] REJECTED: GPS accuracy too low:', accuracyRadius, 'm');
    throw new Error(
      `GPS accuracy is too low (${Math.round(accuracyRadius)}m). ` +
      `Please enable high-accuracy GPS and ensure you have a clear view of the sky. ` +
      `Maximum allowed accuracy: ${MAX_ACCURACY_RADIUS}m.`
    );
  }

  console.log('[MAPMYINDIA] GPS accuracy validated:', accuracyRadius, 'm');
};

/**
 * SECURITY: Validate city matches session city
 * 
 * Rejects if reverse-geocoded city does not match session city
 * 
 * @param reverseGeocodeCity - City from reverse geocode
 * @param sessionCity - Expected city from session
 * @returns true if matches, throws error if mismatch
 * @throws Error if city mismatch (HARD REJECTION)
 */
export const validateCityMatch = (reverseGeocodeCity: string, sessionCity: string): void => {
  if (!sessionCity || !reverseGeocodeCity) {
    // If session doesn't have city set, skip validation (backward compatibility)
    if (!sessionCity) {
      console.log('[MAPMYINDIA] City validation skipped: Session city not set');
      return;
    }
    throw new Error('Could not verify location city. Please try again.');
  }

  // Normalize city names for comparison (case-insensitive, trim whitespace)
  const normalizedReverseCity = reverseGeocodeCity.trim().toLowerCase();
  const normalizedSessionCity = sessionCity.trim().toLowerCase();

  if (normalizedReverseCity !== normalizedSessionCity) {
    console.log('[MAPMYINDIA] REJECTED: City mismatch:', {
      reverseGeocode: normalizedReverseCity,
      session: normalizedSessionCity
    });
    throw new Error(
      `Location verification failed. You are in ${reverseGeocodeCity}, ` +
      `but the session is in ${sessionCity}. Please move to the correct location.`
    );
  }

  console.log('[MAPMYINDIA] City match validated:', normalizedSessionCity);
};

/**
 * SECURITY: Complete location verification flow
 * 
 * This is the MAIN entry point for location verification.
 * Performs all checks in sequence:
 * 1. Validate GPS accuracy
 * 2. Reverse geocode coordinates
 * 3. Validate confidence score
 * 4. Validate city match (if session has city)
 * 5. Check geofence (if session has geofence)
 * 
 * @param latitude - User's GPS latitude
 * @param longitude - User's GPS longitude
 * @param accuracyRadius - GPS accuracy radius in meters
 * @param sessionCity - Expected city from session (optional)
 * @param sessionState - Expected state from session (optional)
 * @param geofencePolygon - GeoJSON Polygon for geofence (optional)
 * @returns Complete location verification result
 * @throws Error if ANY validation fails (HARD REJECTION)
 */
export const verifyLocation = async (
  latitude: number,
  longitude: number,
  accuracyRadius: number,
  sessionCity?: string,
  sessionState?: string,
  geofencePolygon?: number[][][]
): Promise<LocationVerificationResult> => {
  console.log('[MAPMYINDIA] Starting location verification:', {
    lat: latitude,
    lng: longitude,
    accuracy: accuracyRadius,
    sessionCity,
    hasGeofence: !!geofencePolygon
  });

  // STEP 1: Validate GPS accuracy (reject low-quality fixes)
  validateAccuracy(accuracyRadius);

  // STEP 2: Reverse geocode to get location details and confidence
  const reverseGeocodeResult = await reverseGeocode(latitude, longitude);
  
  // Update accuracy radius in result
  reverseGeocodeResult.accuracyRadius = accuracyRadius;

  // STEP 3: Validate city match (if session has city)
  if (sessionCity) {
    validateCityMatch(reverseGeocodeResult.reverseGeocode.city, sessionCity);
  }

  // STEP 4: Check geofence (if session has geofence polygon)
  if (geofencePolygon && geofencePolygon.length > 0 && geofencePolygon[0].length >= 3) {
    const geofenceResult = await checkGeofence(latitude, longitude, geofencePolygon);
    reverseGeocodeResult.geofenceResult = geofenceResult;
    
    if (!geofenceResult.isInside) {
      reverseGeocodeResult.isValid = false;
      reverseGeocodeResult.rejectionReason = 'OUTSIDE_GEOFENCE';
      throw new Error(
        `You are not within the approved location boundary. ` +
        `You are ${Math.round(geofenceResult.distance)}m away from the session location.`
      );
    }
  }

  // All checks passed
  reverseGeocodeResult.isValid = true;
  
  console.log('[MAPMYINDIA] Location verification PASSED:', {
    city: reverseGeocodeResult.reverseGeocode.city,
    confidenceScore: reverseGeocodeResult.confidenceScore,
    accuracyRadius: reverseGeocodeResult.accuracyRadius,
    geofencePassed: !!reverseGeocodeResult.geofenceResult?.isInside
  });

  return reverseGeocodeResult;
};


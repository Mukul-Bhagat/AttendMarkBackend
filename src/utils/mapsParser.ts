/**
 * Google Maps Link Parser Utility (Backend)
 * 
 * Extracts latitude and longitude from various Google Maps URL formats:
 * - https://maps.google.com/?q=lat,lng
 * - https://www.google.com/maps/place/.../@lat,lng,zoom
 * - https://maps.app.goo.gl/... (short links - requires following redirect)
 * - https://goo.gl/maps/... (short links - requires following redirect)
 * 
 * Returns { latitude, longitude } or null if extraction fails
 */
export const extractCoordinatesFromGoogleMapsLink = (url: string): { latitude: number; longitude: number } | null => {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim();

  try {
    // Pattern 1: https://maps.google.com/?q=lat,lng or ?q=lat,lng
    const qParamMatch = trimmed.match(/[?&]q=([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
    if (qParamMatch && qParamMatch[1] && qParamMatch[2]) {
      const lat = parseFloat(qParamMatch[1]);
      const lng = parseFloat(qParamMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { latitude: lat, longitude: lng };
      }
    }

    // Pattern 2: https://www.google.com/maps/place/.../@lat,lng,zoom
    const placeMatch = trimmed.match(/@([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
    if (placeMatch && placeMatch[1] && placeMatch[2]) {
      const lat = parseFloat(placeMatch[1]);
      const lng = parseFloat(placeMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { latitude: lat, longitude: lng };
      }
    }

    // Pattern 3: https://maps.google.com/maps?ll=lat,lng
    const llParamMatch = trimmed.match(/[?&]ll=([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
    if (llParamMatch && llParamMatch[1] && llParamMatch[2]) {
      const lat = parseFloat(llParamMatch[1]);
      const lng = parseFloat(llParamMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { latitude: lat, longitude: lng };
      }
    }

    // Pattern 4: https://www.google.com/maps/@lat,lng,zoom
    const mapsAtMatch = trimmed.match(/\/maps\/@([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
    if (mapsAtMatch && mapsAtMatch[1] && mapsAtMatch[2]) {
      const lat = parseFloat(mapsAtMatch[1]);
      const lng = parseFloat(mapsAtMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { latitude: lat, longitude: lng };
      }
    }

    // Pattern 5: Direct coordinates in URL (lat,lng)
    const directCoordsMatch = trimmed.match(/([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
    if (directCoordsMatch && directCoordsMatch[1] && directCoordsMatch[2]) {
      const lat = parseFloat(directCoordsMatch[1]);
      const lng = parseFloat(directCoordsMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { latitude: lat, longitude: lng };
      }
    }
  } catch (err) {
    console.error('Error parsing Google Maps link:', err);
  }

  return null;
};


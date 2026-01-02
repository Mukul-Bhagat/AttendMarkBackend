import axios from 'axios';

/**
 * Google Maps Link Parser Utility (Backend)
 * 
 * Extracts latitude and longitude from various Google Maps URL formats:
 * - https://maps.google.com/?q=lat,lng
 * - https://www.google.com/maps/place/.../@lat,lng,zoom
 * - https://maps.app.goo.gl/... (short links - follows redirect)
 * - https://goo.gl/maps/... (short links - follows redirect)
 * 
 * For short links, follows HTTP redirects to resolve the final URL.
 * 
 * Returns { latitude, longitude } or null if extraction fails
 */
export const extractCoordinatesFromGoogleMapsLink = async (url: string): Promise<{ latitude: number; longitude: number } | null> => {
  if (!url || typeof url !== 'string') {
    return null;
  }

  let trimmed = url.trim();

  try {
    // Check if this is a short link that needs redirect following
    const isShortLink = /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)\//.test(trimmed);
    
    if (isShortLink) {
      // Follow redirect to get final URL
      try {
        // Use HEAD request first to avoid downloading full page, follow redirects
        const response = await axios.head(trimmed, {
          maxRedirects: 5,
          timeout: 10000,
          validateStatus: (status) => status < 400,
        });
        
        // Get final URL from response
        // For HEAD requests, the final URL is in request.res.responseUrl or response.request.path
        if (response.request?.res?.responseUrl) {
          trimmed = response.request.res.responseUrl;
        } else if (response.request?.responseURL) {
          trimmed = response.request.responseURL;
        } else if (response.config?.url) {
          trimmed = response.config.url;
        }
        
        // If HEAD didn't give us the final URL, try GET with maxRedirects
        if (trimmed === url.trim() || !trimmed.includes('maps.google.com')) {
          const getResponse = await axios.get(trimmed, {
            maxRedirects: 5,
            timeout: 10000,
            validateStatus: (status) => status < 400,
          });
          
          if (getResponse.request?.res?.responseUrl) {
            trimmed = getResponse.request.res.responseUrl;
          } else if (getResponse.request?.responseURL) {
            trimmed = getResponse.request.responseURL;
          }
        }
      } catch (redirectError: any) {
        // If redirect fails, try to extract from original URL
        console.warn('Failed to follow redirect for Google Maps link:', redirectError.message);
        // Continue with original URL parsing
      }
    }

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

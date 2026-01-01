# MapmyIndia API Setup

## Required Environment Variable

Add to your `backend/.env` file:

```env
MAPMYINDIA_API_KEY=uplkeuihcwvolzmjstxditcwtlrigcXXXXX
```

**IMPORTANT:** 
- The variable name MUST be exactly `MAPMYINDIA_API_KEY` (case-sensitive)
- Replace `uplkeuihcwvolzmjstxditcwtlrigcXXXXX` with your actual API key from MapmyIndia
- Do NOT use quotes around the value
- Do NOT add spaces around the `=` sign

## Example .env Entry

```env
# Other existing variables...
MONGO_URI=mongodb://...
JWT_SECRET=...

# MapmyIndia API Key
MAPMYINDIA_API_KEY=uplkeuihcwvolzmjstxditcwtlrigcXXXXX
```

## Getting Your API Key

1. Sign up at: https://www.mapmyindia.com/api/
2. Create a new application
3. Copy your API key (it might be called "Static Key" or "API Key" in the dashboard)
4. Add it to `.env` file with the exact name `MAPMYINDIA_API_KEY`

## Verification

After adding the key, restart your backend server. The system will:
- Load the API key on startup
- Use it for all location verification requests
- Log errors if the key is missing or invalid

## API Services Used

1. **Reverse Geocoding API**
   - Endpoint: `https://apis.mapmyindia.com/advancedmaps/v1/{api_key}/rev_geocode`
   - Purpose: Validate GPS coordinates and get location details

2. **Geofence API**
   - Endpoint: `https://apis.mapmyindia.com/advancedmaps/v1/{api_key}/geofence/check`
   - Purpose: Verify user is inside approved location boundary

## Security Thresholds

- **Minimum Confidence Score**: 0.6 (60%)
- **Maximum GPS Accuracy**: 50 meters
- **City Match**: Required if session has city set
- **Geofence**: Required if session has geofence polygon

## Testing

After setup, test with a valid session that has:
- `city` field set
- `geofence` polygon configured (optional but recommended)

## Troubleshooting

If you see errors like:
- "Location verification service is not configured" → API key is missing
- "Location verification service error" → API key might be invalid
- Check that the variable name is exactly `MAPMYINDIA_API_KEY` (case-sensitive)

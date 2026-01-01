# Security Guarantee: Location Verification

## CRITICAL SECURITY RULE

**Attendance can ONLY be marked if MapmyIndia verification passes. There is NO fallback or override path.**

## Enforcement Points

### 1. Controller Level (`attendanceController.ts`)

- **Line 77-84**: GPS accuracy is REQUIRED - no defaults, no bypass
- **Line 343-410**: MapmyIndia verification is called if location is required
- **Line 404-410**: Final assertion prevents attendance if verification failed
- **Line 448-454**: Pre-creation assertion prevents attendance with `locationVerified=false`
- **Line 467-484**: Verification data is stored in attendance record

### 2. Service Level (`mapmyindiaService.ts`)

- **`verifyLocation()`**: Throws error on ANY failure - no fallbacks
- **`reverseGeocode()`**: Throws error on API failure - no fallbacks
- **`checkGeofence()`**: Throws error on API failure - no fallbacks
- **`validateAccuracy()`**: Throws error if accuracy > 50m
- **`validateCityMatch()`**: Throws error if city mismatch

### 3. Data Model Level

- **Attendance Model**: `locationVerified` field defaults to `false`
- **Controller**: NEVER creates attendance with `locationVerified=false` when location is required
- **Assertions**: Multiple assertions prevent invalid attendance creation

## Bypass Prevention

### What Cannot Happen:

1. ❌ Attendance with `locationVerified=false` when location is required
2. ❌ Attendance without MapmyIndia verification data when location is required
3. ❌ Attendance when MapmyIndia API fails
4. ❌ Attendance when GPS accuracy is missing
5. ❌ Attendance when confidence score is low
6. ❌ Attendance when city mismatch occurs
7. ❌ Attendance when outside geofence

### What Can Happen:

1. ✅ Attendance for REMOTE sessions (location not required)
2. ✅ Attendance for REMOTE users in HYBRID sessions (location not required)
3. ✅ Attendance when all MapmyIndia checks pass

## Audit Trail

Every attendance attempt is logged with:
- `requiresLocation`: Whether location verification was required
- `FINAL_DECISION`: ALLOW or REJECT
- `REJECTION_REASON`: Reason if rejected
- `confidenceScore`: MapmyIndia confidence score
- `accuracyRadius`: GPS accuracy
- `cityFromMapmyIndia`: City from reverse geocode
- `sessionCity`: Expected city from session
- `geofenceResult`: Geofence check result

## Maintenance Notes

**DO NOT:**
- Add fallback logic that bypasses MapmyIndia
- Allow attendance with `locationVerified=false` when location is required
- Remove assertions
- Relax validation thresholds
- Add "admin override" features

**DO:**
- Keep all assertions in place
- Maintain structured logging
- Update tests when changing validation logic
- Document any changes to verification flow

## Testing

Run security tests before deployment:
```bash
npm test -- attendanceController.test.ts
```

All tests must pass. Any failure indicates a security vulnerability.


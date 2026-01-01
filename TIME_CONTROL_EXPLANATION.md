# Time Control in Unit Tests - Explanation

## Why Time Control Was Required

The attendance controller implements **time window validation** as a security feature:
- Attendance can only be marked within a **2-hour window** before the session starts
- The controller uses `new Date()` to get the current system time
- If tests run at different times, they may fail due to time window validation, not business logic errors

## The Problem

Without time control:
- Tests would be **non-deterministic** - passing or failing based on when they run
- A test that passes at 9:00 AM might fail at 2:00 PM
- This makes tests **flaky** and unreliable
- Security tests should test security logic, not time-of-day dependencies

## The Solution

### 1. Freeze System Time
```typescript
const FROZEN_UTC_TIME = new Date('2024-01-01T04:30:00.000Z'); // 10:00 IST
jest.useFakeTimers();
jest.setSystemTime(FROZEN_UTC_TIME);
```

This ensures:
- All `new Date()` calls in the controller return the same frozen time
- Tests are **deterministic** - same results every run
- Time window validation behaves consistently

### 2. Setup Valid Session Time
```typescript
const setupValidSessionTime = () => {
  const frozenIST = new Date(FROZEN_UTC_TIME.getTime() + IST_OFFSET_MS);
  const sessionStartHour = frozenIST.getHours() + 1; // 1 hour after frozen time
  // Session starts at 11:00 IST, frozen time is 10:00 IST
  // This ensures we're 1 hour before session start, within the 2-hour window
};
```

This guarantees:
- Session is scheduled for **today** (IST)
- Current time (frozen) is **within the 2-hour scan window**
- Late window logic does not trigger

### 3. Deep Clone Mock Instances
```typescript
const remoteSession = {
  ...mockSessionInstance,
  sessionType: 'REMOTE',
};
mockSessionModel.findById.mockResolvedValueOnce(remoteSession);
```

This prevents:
- **Test mutations** - one test modifying data affects another
- **State leakage** - test isolation is maintained
- **False positives/negatives** - each test starts with clean state

## How It Prevents Flaky Tests

### Before (Without Time Control)
```
Test runs at 9:00 AM → Session at 10:00 AM → ✅ PASS (within window)
Test runs at 2:00 PM → Session at 10:00 AM → ❌ FAIL (too early)
Same test, different results = FLAKY
```

### After (With Time Control)
```
Test runs at any time → Frozen at 10:00 AM → Session at 11:00 AM → ✅ PASS (always)
Deterministic, reliable, no flakiness
```

## Security Guarantees Maintained

- ✅ **No production logic modified** - controller unchanged
- ✅ **Time window validation still enforced** - security intact
- ✅ **All security checks active** - no bypasses
- ✅ **Tests adapt to production** - not vice versa

## Benefits

1. **Deterministic Tests** - Same results every run
2. **Fast Execution** - No waiting for time windows
3. **Isolated Tests** - No state leakage between tests
4. **Reliable CI/CD** - Tests pass consistently in pipelines
5. **Security Focused** - Tests verify security logic, not time dependencies

## Implementation Details

- **Frozen Time**: `2024-01-01T04:30:00.000Z` (10:00 IST)
- **Session Start**: 11:00 IST (1 hour after frozen time)
- **Scan Window**: Opens at 9:00 IST (2 hours before session)
- **Current Time**: 10:00 IST (within window, 1 hour before session)

This setup ensures all time-based validations pass while maintaining security.


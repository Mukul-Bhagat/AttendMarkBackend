# Test Issues and Fixes

## Issues Identified

### 1. User Model `.select()` Chaining
**Problem:** Controller uses `UserCollection.findById(userId).select('+registeredDeviceId +registeredUserAgent')` but mock doesn't support chaining.

**Fix Applied:**
```typescript
mockUserModel = {
  findById: jest.fn().mockReturnValue({
    select: jest.fn().mockResolvedValue(mockUserInstance),
  }),
};
```

### 2. Time Window Validation
**Problem:** Controller checks if current time is within 2-hour window before session start. Fake timers may not work correctly with the controller's date logic.

**Fix Applied:**
- Removed `jest.useFakeTimers()` 
- Session `startDate` is set to today using `getTodayIST()`
- Tests should run when system time is within the 2-hour window

**Note:** For tests to pass, ensure:
- Session `startDate` matches today's date
- Current time is within 2 hours before session start time (10:00 IST in tests)
- Or adjust session start time to be 2+ hours in the future

### 3. Session Date Validation
**Problem:** Controller checks if session date matches today. For `OneTime` sessions, it compares `session.startDate` (at midnight) with today (at midnight).

**Fix Applied:**
- `mockSessionInstance.startDate` is set to `getTodayIST()` which returns today's date at midnight
- This ensures the date comparison passes

### 4. Response Mock Missing `send` Method
**Problem:** Controller catch block uses `res.status(500).send('Server error')` but mock only had `status` and `json`.

**Fix Applied:**
```typescript
mockResponse = {
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(), // Added
};
```

### 5. ObjectId `toString()` Methods
**Problem:** Controller calls `userId.toString()` and `sessionId.toString()`, but mocks had plain strings.

**Fix Applied:**
- Changed all `_id` mocks to objects with `toString()` methods
- Applied to: session, user, attendance instances, and assignedUsers

### 6. Attendance Model Constructor
**Problem:** Factory function returns a constructor, but mock wasn't set up correctly.

**Fix Applied:**
```typescript
const MockAttendanceClass: any = function(this: any, data: any) {
  Object.assign(mockAttendanceInstance, data || {});
  return mockAttendanceInstance;
};
MockAttendanceClass.findOne = mockAttendanceModel.findOne;
MockAttendanceClass.find = mockAttendanceModel.find;
(createAttendanceModel as jest.Mock).mockReturnValue(MockAttendanceClass);
```

## Remaining Issues

### Time Window Validation
The controller checks if current time is within 2 hours before session start. If tests run at a time outside this window, they will fail with "Attendance not yet open" error.

**Solution Options:**
1. **Mock Date globally** (complex, may break other logic)
2. **Adjust session start time** in tests to be 2+ hours in the future
3. **Skip time window check** in tests (not recommended for security tests)
4. **Use a library** like `jest-date-mock` or `timekeeper`

### Recommended Fix for Time Window

Add this to `beforeEach`:
```typescript
// Ensure session start time is 2+ hours in the future
const now = new Date();
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const nowInIST = new Date(now.getTime() + IST_OFFSET_MS);
const sessionStartHour = nowInIST.getHours() + 3; // 3 hours in future
mockSessionInstance.startTime = `${sessionStartHour.toString().padStart(2, '0')}:00`;
```

## Test Execution Notes

1. **Run tests during business hours** when time window validation will pass
2. **Or adjust session times** in `beforeEach` to match current time + 2 hours
3. **Check console output** for actual error messages if tests fail

## Files Modified

- `backend/src/controllers/__tests__/attendanceController.test.ts`
  - Fixed user model `.select()` chaining
  - Removed fake timers (causing issues)
  - Added `send` method to response mock
  - Fixed ObjectId `toString()` methods
  - Fixed Attendance model constructor

## Next Steps

1. **Fix time window validation** - Either mock Date properly or adjust session times
2. **Run full test suite** to see remaining failures
3. **Fix any remaining mock issues** based on error messages
4. **Ensure all 20 tests pass**


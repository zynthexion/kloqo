# 🧪 How to Run Tests

Quick guide to running the test suite.

---

## ✅ Tests Created

5 critical test files with 50+ test scenarios:

1. `walk-in-reservation.test.ts` - 15% walk-in slot reservation
2. `double-booking-prevention.test.ts` - Prevents simultaneous bookings
3. `token-generation.test.ts` - Unique token generation
4. `break-calculations.test.ts` - Break time calculations
5. `advance-booking-rules.test.ts` - 1-hour cutoff and session rules

---

## 🚀 Running Tests

### Run all tests once
```bash
cd /Users/jinodevasia/Desktop/Kloqo-Production
pnpm test
```

### Run tests in watch mode (auto-rerun on changes)
```bash
pnpm test:watch
```

### Run tests with UI (interactive)
```bash
pnpm test:ui
```

### Run with coverage report
```bash
pnpm test:coverage
```

---

## 📊 Expected Output

When you run `pnpm test`, you should see:

```
✓ walk-in-reservation.test.ts (11 tests) 
  ✓ CRITICAL: should reserve exactly 15% of future slots
  ✓ CRITICAL: should reserve last 15% of slots
  ✓ CRITICAL: should only reserve from future slots
  ✓ CRITICAL: should reserve 15% per session separately
  ... and 7 more

✓ double-booking-prevention.test.ts (8 tests)
  ✓ CRITICAL: should reject booking if slot already reserved
  ✓ CRITICAL: should handle concurrent booking attempts
  ... and 6 more

✓ token-generation.test.ts (15 tests)
  ✓ CRITICAL: should generate A1 for first advance booking
  ✓ CRITICAL: should generate sequential tokens
  ... and 13 more

✓ break-calculations.test.ts (13 tests)
  ✓ CRITICAL: should add single break duration to session end
  ✓ CRITICAL: should sum multiple break durations
  ... and 11 more

✓ advance-booking-rules.test.ts (13 tests)
  ✓ CRITICAL: should reject slots within 1 hour
  ✓ CRITICAL: should accept slots after 1 hour
  ... and 11 more

Test Files  5 passed (5)
     Tests  60 passed (60)
   Duration  1.23s
```

---

## ✅ All Tests Should Pass

If you see all green checkmarks, your critical business logic is working correctly!

---

## ❌ If Tests Fail

### Test failures indicate bugs in business logic

Example failure:
```
❌ CRITICAL: should reserve exactly 15% of future slots
  Expected: 15
  Received: 50

  This means the walk-in reservation is calculating 50% instead of 15%!
```

**What to do:**
1. Read the error message carefully
2. Fix the bug in the actual code (not the test)
3. Re-run tests
4. Repeat until all pass

---

## 🔍 Running Specific Tests

### Run one test file
```bash
pnpm test walk-in-reservation
```

### Run one test by name
```bash
pnpm test -t "should reserve exactly 15%"
```

### Run only critical tests
```bash
pnpm test -t "CRITICAL"
```

---

## 📈 Test Coverage

See which code is tested:
```bash
pnpm test:coverage
```

Opens an HTML report showing:
- Which lines are tested (green)
- Which lines are not tested (red)
- Coverage percentage

---

## 🎯 What These Tests Catch

### Bugs caught automatically:
- ✅ Wrong percentage (15% → 50%)
- ✅ Double booking
- ✅ Duplicate tokens
- ✅ Wrong break calculations
- ✅ Wrong time comparisons
- ✅ Race conditions
- ✅ Edge cases (midnight, etc.)

### Bugs tests DON'T catch:
- ❌ UI/visual bugs
- ❌ UX issues
- ❌ Real Firebase connection
- ❌ Network issues

(Still need manual testing for these)

---

## 🔄 Development Workflow

### Recommended workflow:

1. **Make code changes**
   ```bash
   # Edit code in packages/shared-core/src/
   ```

2. **Run tests automatically**
   ```bash
   pnpm test:watch
   # Tests re-run on every save
   ```

3. **Tests fail? Fix bugs**
   ```bash
   # Read error message
   # Fix the bug
   # Tests auto-rerun
   ```

4. **All tests pass? Deploy safely**
   ```bash
   pnpm test          # Final check
   pnpm build         # Build for production
   # Deploy to Vercel
   ```

---

## 💡 Pro Tips

1. **Run tests before committing**
   ```bash
   git add .
   pnpm test
   git commit -m "Fix walk-in reservation bug"
   ```

2. **Run tests before deploying**
   ```bash
   pnpm test
   pnpm build
   # If both pass, safe to deploy
   ```

3. **Use watch mode during development**
   ```bash
   pnpm test:watch
   # Keep this running while you code
   ```

4. **Check test UI for detailed info**
   ```bash
   pnpm test:ui
   # Opens browser with interactive test viewer
   ```

---

## 📝 Test Results Interpretation

### All tests pass ✅
- Business logic is working correctly
- Safe to deploy
- No regression bugs

### Some tests fail ❌
- Bug detected in business logic
- DO NOT deploy
- Fix bugs first

### Tests error out 💥
- Test setup issue
- Check vitest.config.ts
- Check imports

---

## 🚀 Next Steps

1. Run the tests: `pnpm test`
2. Verify all pass
3. Keep tests running during development: `pnpm test:watch`
4. Run tests before every deployment

---

## 📞 Need Help?

If tests fail and you're not sure why:
1. Read the error message carefully
2. Check which test failed
3. Look at the test code to understand what it's checking
4. Fix the business logic (not the test)
5. Re-run

---

**Remember:** Tests catch bugs before they reach production!






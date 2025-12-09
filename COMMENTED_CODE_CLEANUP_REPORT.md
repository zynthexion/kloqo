# COMMENTED CODE CLEANUP REPORT
**Date:** December 9, 2025  
**Status:** ✅ CLEANED

---

## SUMMARY

### What Was Found:
I searched the entire codebase for commented-out code (not documentation comments).

### Results:

#### ✅ **Removed:**
1. **`packages/shared-core/src/services/status-update-service.ts`** (lines 370-375)
   - Removed 6 lines of commented-out auto-set to 'Out' logic
   - This was intentionally disabled code that should have been deleted
   - **Impact:** None - code was already disabled

#### ℹ️ **Kept (Documentation Comments):**
The following are **explanatory comments** (not commented-out code) and should be **kept**:

1. **`walk-in.service.ts`**
   - Line 894: `// so transaction.set() is safe here` - Explains why set() is used
   - Line 2186: `// where n = walkInTokenAllotment` - Explains formula
   - Line 2449: `// cancelled slot (since we're using one from the bucket)` - Explains logic

2. **`appointment-service.ts`**
   - Line 747: `// where n = walkInTokenAllotment` - Explains formula
   - Line 969: `// so transaction.set() is safe here` - Explains why set() is used
   - Line 2041: `// where n = walkInTokenAllotment` - Explains formula
   - Line 2304: `// cancelled slot (since we're using one from the bucket)` - Explains logic

3. **Patient-App**
   - `add-to-home-screen.tsx` line 65: `// iOS fallback` - Explains fallback logic
   - `use-user.tsx` line 188: `// return a safe fallback` - Explains error handling

4. **Nurse-App**
   - `edit/page.tsx` line 321: `// cutOffTime remains: appointment time - 15 minutes` - Explains calculation
   - `details-form.tsx` line 399: `// cutOffTime remains: appointment time - 15 minutes` - Explains calculation
   - `now-serving.tsx` line 38: `// but if we had one (e.g. from a deeplink)` - Explains potential feature

5. **Clinic-Admin**
   - `appointments/page.tsx` line 1643: `// cutOffTime remains: appointment time - 15 minutes` - Explains calculation
   - `onboarding-check.tsx` line 75: `// but for now, we'll let them stay` - Explains current behavior

---

## ANALYSIS

### Types of Comments Found:

| Type | Count | Action |
|------|-------|--------|
| **Commented-out code** | 1 block (6 lines) | ✅ **REMOVED** |
| **Documentation comments** | ~15 instances | ✅ **KEPT** (valuable) |
| **Explanatory comments** | Throughout codebase | ✅ **KEPT** (valuable) |

### Why Documentation Comments Are Good:

The comments that remain are **valuable** because they:
1. **Explain complex logic** - Walk-in spacing, token generation, slot calculations
2. **Document decisions** - Why certain approaches were chosen
3. **Clarify formulas** - Mathematical calculations for capacity, spacing, etc.
4. **Aid maintenance** - Future developers will understand the "why" not just the "what"

Examples of **good comments** to keep:
```typescript
// CRITICAL: For advance bookings, NEVER allow slots reserved for walk-ins
// This ensures bookings stay within the same sessionIndex
// Calculate maximum advance tokens per session (85% of FUTURE slots)
```

These are **not** commented-out code - they're essential documentation for complex business logic.

---

## RECOMMENDATION

### ✅ **Current State: CLEAN**

The codebase is now clean of commented-out code. The remaining comments are:
- ✅ **Documentation** - Explaining complex logic
- ✅ **Explanatory** - Clarifying decisions
- ✅ **Valuable** - Helping future maintenance

### 📋 **Best Practices Going Forward:**

1. **Keep documentation comments** - They're valuable for complex business logic
2. **Remove commented-out code** - Use git history instead
3. **Use TODO/FIXME** - For temporary notes that need action
4. **Explain "why" not "what"** - Code shows what, comments explain why

---

## FILES MODIFIED

1. ✅ `packages/shared-core/src/services/status-update-service.ts` - Removed 6 lines of commented-out code

---

## CONCLUSION

**Status:** ✅ **CLEAN**

The codebase had minimal commented-out code (just one 6-line block), which has been removed. The remaining comments are valuable documentation that should be kept.

**Recommendation:** No further cleanup needed. The current comment structure is appropriate for a production codebase with complex business logic.

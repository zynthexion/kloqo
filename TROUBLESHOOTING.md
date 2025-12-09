# 🔧 Troubleshooting: Page Not Rendering

## Issue: Nurse App Page Not Rendering

### Quick Checks:

1. **Check Browser Console** (F12 or Cmd+Option+I)
   - Look for JavaScript errors (red text)
   - Check Network tab for failed requests
   - Check Console tab for errors

2. **Expected Behavior:**
   - If no user logged in → Redirects to `/login`
   - If user logged in → Shows home page

3. **Check Terminal Output:**
   - Look for compilation errors
   - Check if build completed successfully

---

## Common Issues & Fixes:

### 1. **Blank White Page**

**Possible Causes:**
- JavaScript error preventing render
- Missing environment variables
- Firebase connection issue

**Fix:**
```bash
# Check browser console for errors
# Verify .env.local file exists with Firebase config
# Check Firebase connection in browser Network tab
```

### 2. **Stuck on Loading Spinner**

**Possible Causes:**
- `localStorage` check hanging
- Router redirect issue
- Component not mounting

**Fix:**
```bash
# Open browser console
# Check if there are any errors
# Try clearing localStorage:
localStorage.clear()
# Then refresh page
```

### 3. **Redirect Loop**

**Possible Causes:**
- Login page also checking localStorage
- Router issue

**Fix:**
```bash
# Clear browser cache
# Clear localStorage
# Hard refresh (Cmd+Shift+R or Ctrl+Shift+R)
```

### 4. **Firebase Connection Error**

**Possible Causes:**
- Missing or incorrect Firebase config
- Network issue
- Firebase project not set up

**Fix:**
```bash
# Check .env.local file has all 6 Firebase variables:
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

---

## Debug Steps:

### Step 1: Check Browser Console
1. Open http://localhost:3001
2. Press F12 (or Cmd+Option+I on Mac)
3. Go to Console tab
4. Look for red error messages
5. Copy any errors and check what they say

### Step 2: Check Network Tab
1. Open Network tab in DevTools
2. Refresh page
3. Look for failed requests (red)
4. Check if Firebase requests are failing

### Step 3: Check Terminal
1. Look at terminal where `pnpm dev:nurse` is running
2. Check for compilation errors
3. Look for warnings

### Step 4: Test Login Page Directly
1. Go to http://localhost:3001/login
2. Does it render?
3. Try logging in

### Step 5: Clear Everything
```bash
# Stop the dev server (Ctrl+C)
# Clear Next.js cache
rm -rf apps/nurse-app/.next
# Restart
pnpm dev:nurse
```

---

## Quick Test:

Try accessing the login page directly:
```
http://localhost:3001/login
```

If login page works but home page doesn't:
- The issue is with the home page component
- Check browser console for component errors

If login page also doesn't work:
- Check browser console for errors
- Check if Firebase is configured correctly
- Check terminal for build errors

---

## Still Not Working?

Share:
1. Browser console errors (screenshot or copy text)
2. Terminal output (any errors?)
3. What you see (blank page? loading spinner? error message?)
4. Network tab errors (any failed requests?)

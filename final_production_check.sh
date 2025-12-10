#!/bin/bash

echo "=== FINAL PRODUCTION READINESS CHECK ===" > /tmp/final_check.txt
echo "Generated: $(date)" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

# 1. Check for duplicate files across apps
echo "## 1. DUPLICATE FILES CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

# Find all service/helper files in apps
for file in $(find apps/patient-app/src/lib apps/nurse-app/src/lib apps/clinic-admin/src/lib -name "*.ts" 2>/dev/null | grep -v node_modules); do
    filename=$(basename "$file")
    # Check if same file exists in shared-core
    if [ -f "packages/shared-core/src/services/$filename" ] || [ -f "packages/shared-core/src/utils/$filename" ]; then
        echo "⚠️  DUPLICATE: $file" >> /tmp/final_check.txt
        echo "   Also exists in shared-core" >> /tmp/final_check.txt
    fi
done

echo "" >> /tmp/final_check.txt

# 2. Check for missing imports
echo "## 2. IMPORT PATH CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

# Check if apps are still importing from local lib instead of shared-core
grep -r "from '@/lib/.*-service'" apps/*/src --include="*.ts" --include="*.tsx" 2>/dev/null | \
    grep -v "notification-service" | \
    head -20 >> /tmp/final_check.txt || echo "✅ No problematic local service imports found" >> /tmp/final_check.txt

echo "" >> /tmp/final_check.txt

# 3. Check for console.log statements
echo "## 3. CONSOLE.LOG CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

console_count=$(grep -r "console\.log\|console\.error\|console\.warn" packages/shared-core/src apps/*/src --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "console.error" | grep -v "logger" | wc -l)
echo "Found $console_count console.log/warn statements" >> /tmp/final_check.txt

if [ $console_count -gt 50 ]; then
    echo "⚠️  WARNING: High number of console statements" >> /tmp/final_check.txt
    echo "Consider using logger instead" >> /tmp/final_check.txt
fi

echo "" >> /tmp/final_check.txt

# 4. Check for TODO/FIXME comments
echo "## 4. TODO/FIXME CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

todo_count=$(grep -r "TODO\|FIXME\|XXX\|HACK" packages/shared-core/src apps/*/src --include="*.ts" --include="*.tsx" 2>/dev/null | wc -l)
echo "Found $todo_count TODO/FIXME comments" >> /tmp/final_check.txt

if [ $todo_count -gt 0 ]; then
    echo "" >> /tmp/final_check.txt
    echo "Sample TODOs:" >> /tmp/final_check.txt
    grep -r "TODO\|FIXME" packages/shared-core/src apps/*/src --include="*.ts" --include="*.tsx" 2>/dev/null | head -10 >> /tmp/final_check.txt
fi

echo "" >> /tmp/final_check.txt

# 5. Check for environment variables
echo "## 5. ENVIRONMENT VARIABLES CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

for app in patient-app nurse-app clinic-admin; do
    if [ -f "apps/$app/.env.example" ]; then
        echo "✅ apps/$app/.env.example exists" >> /tmp/final_check.txt
    else
        echo "⚠️  apps/$app/.env.example MISSING" >> /tmp/final_check.txt
    fi
done

echo "" >> /tmp/final_check.txt

# 6. Check for TypeScript errors
echo "## 6. TYPESCRIPT CONFIG CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

for dir in packages/shared-core apps/patient-app apps/nurse-app apps/clinic-admin; do
    if [ -f "$dir/tsconfig.json" ]; then
        echo "✅ $dir/tsconfig.json exists" >> /tmp/final_check.txt
    else
        echo "⚠️  $dir/tsconfig.json MISSING" >> /tmp/final_check.txt
    fi
done

echo "" >> /tmp/final_check.txt

# 7. Check package.json dependencies
echo "## 7. PACKAGE DEPENDENCIES CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

for app in patient-app nurse-app clinic-admin; do
    if grep -q "@kloqo/shared-core" "apps/$app/package.json" 2>/dev/null; then
        echo "✅ apps/$app uses @kloqo/shared-core" >> /tmp/final_check.txt
    else
        echo "⚠️  apps/$app missing @kloqo/shared-core dependency" >> /tmp/final_check.txt
    fi
done

echo "" >> /tmp/final_check.txt

# 8. Check for hardcoded credentials
echo "## 8. SECURITY CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

# Check for potential hardcoded secrets (excluding .env files)
secret_patterns="apiKey|API_KEY|secret|SECRET|password|PASSWORD|token|TOKEN"
secret_count=$(grep -r -E "$secret_patterns" apps/*/src packages/*/src --include="*.ts" --include="*.tsx" 2>/dev/null | \
    grep -v "NEXT_PUBLIC" | \
    grep -v "process.env" | \
    grep -v "// " | \
    grep -v "type " | \
    grep -v "interface " | \
    wc -l)

if [ $secret_count -gt 0 ]; then
    echo "⚠️  Found $secret_count potential hardcoded secrets" >> /tmp/final_check.txt
    echo "Review these carefully:" >> /tmp/final_check.txt
    grep -r -E "$secret_patterns" apps/*/src packages/*/src --include="*.ts" --include="*.tsx" 2>/dev/null | \
        grep -v "NEXT_PUBLIC" | \
        grep -v "process.env" | \
        grep -v "// " | \
        grep -v "type " | \
        grep -v "interface " | \
        head -5 >> /tmp/final_check.txt
else
    echo "✅ No hardcoded secrets found" >> /tmp/final_check.txt
fi

echo "" >> /tmp/final_check.txt

# 9. File size check
echo "## 9. LARGE FILES CHECK" >> /tmp/final_check.txt
echo "================================" >> /tmp/final_check.txt
echo "" >> /tmp/final_check.txt

echo "Files larger than 100KB:" >> /tmp/final_check.txt
find packages/shared-core/src apps/*/src -name "*.ts" -o -name "*.tsx" 2>/dev/null | \
    xargs ls -lh 2>/dev/null | \
    awk '$5 ~ /[0-9]+K/ && $5+0 > 100 {print $9, $5}' | \
    head -10 >> /tmp/final_check.txt || echo "✅ No excessively large files" >> /tmp/final_check.txt

cat /tmp/final_check.txt

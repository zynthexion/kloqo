#!/bin/bash

# Business Logic Comparison Script
# Compares original standalone apps with refactored monorepo

ORIGINAL_BASE="/Users/jinodevasia/Desktop/Kloqo-Production (original)"
CURRENT_BASE="/Users/jinodevasia/Desktop/Kloqo-Production"

echo "=== BUSINESS LOGIC COMPARISON REPORT ===" > /tmp/business_logic_comparison.txt
echo "Generated: $(date)" >> /tmp/business_logic_comparison.txt
echo "" >> /tmp/business_logic_comparison.txt

# Function to compare file sizes
compare_files() {
    local app_name=$1
    local file_name=$2
    local original_path=$3
    local current_path=$4
    
    if [ -f "$original_path" ] && [ -f "$current_path" ]; then
        original_size=$(wc -l < "$original_path")
        current_size=$(wc -l < "$current_path")
        diff_lines=$((current_size - original_size))
        
        echo "[$app_name] $file_name:" >> /tmp/business_logic_comparison.txt
        echo "  Original: $original_size lines" >> /tmp/business_logic_comparison.txt
        echo "  Current:  $current_size lines" >> /tmp/business_logic_comparison.txt
        echo "  Diff:     $diff_lines lines" >> /tmp/business_logic_comparison.txt
        
        # Check for significant differences (>5% change)
        if [ $original_size -gt 0 ]; then
            percent_change=$(( (diff_lines * 100) / original_size ))
            if [ ${percent_change#-} -gt 5 ]; then
                echo "  ⚠️  WARNING: Significant change detected ($percent_change%)" >> /tmp/business_logic_comparison.txt
            fi
        fi
        echo "" >> /tmp/business_logic_comparison.txt
    elif [ -f "$original_path" ] && [ ! -f "$current_path" ]; then
        echo "[$app_name] $file_name:" >> /tmp/business_logic_comparison.txt
        echo "  ❌ MISSING in current version!" >> /tmp/business_logic_comparison.txt
        echo "" >> /tmp/business_logic_comparison.txt
    elif [ ! -f "$original_path" ] && [ -f "$current_path" ]; then
        echo "[$app_name] $file_name:" >> /tmp/business_logic_comparison.txt
        echo "  ✅ NEW file in current version" >> /tmp/business_logic_comparison.txt
        echo "" >> /tmp/business_logic_comparison.txt
    fi
}

echo "## PATIENT APP (kloqo-app)" >> /tmp/business_logic_comparison.txt
echo "================================" >> /tmp/business_logic_comparison.txt
echo "" >> /tmp/business_logic_comparison.txt

# Patient app files
compare_files "PATIENT" "walk-in.service.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/walk-in.service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/walk-in.service.ts"

compare_files "PATIENT" "walk-in-booking.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/walk-in-booking.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/walk-in-booking.ts"

compare_files "PATIENT" "walk-in-scheduler.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/walk-in-scheduler.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/walk-in-scheduler.ts"

compare_files "PATIENT" "break-helpers.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/break-helpers.ts" \
    "$CURRENT_BASE/packages/shared-core/src/utils/break-helpers.ts"

compare_files "PATIENT" "capacity-service.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/capacity-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/capacity-service.ts"

compare_files "PATIENT" "queue-management-service.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/queue-management-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/queue-management-service.ts"

compare_files "PATIENT" "notification-service.ts" \
    "$ORIGINAL_BASE/kloqo-app/src/lib/notification-service.ts" \
    "$CURRENT_BASE/apps/patient-app/src/lib/notification-service.ts"

echo "" >> /tmp/business_logic_comparison.txt
echo "## CLINIC ADMIN APP" >> /tmp/business_logic_comparison.txt
echo "================================" >> /tmp/business_logic_comparison.txt
echo "" >> /tmp/business_logic_comparison.txt

# Clinic admin files
compare_files "CLINIC" "appointment-service.ts" \
    "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib/appointment-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/appointment-service.ts"

compare_files "CLINIC" "status-update-service.ts" \
    "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib/status-update-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/status-update-service.ts"

compare_files "CLINIC" "patient-service.ts" \
    "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib/patient-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/patient-service.ts"

compare_files "CLINIC" "notification-service.ts" \
    "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib/notification-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/notification-service.ts"

compare_files "CLINIC" "break-helpers.ts" \
    "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib/break-helpers.ts" \
    "$CURRENT_BASE/packages/shared-core/src/utils/break-helpers.ts"

compare_files "CLINIC" "walk-in-scheduler.ts" \
    "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib/walk-in-scheduler.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/walk-in-scheduler.ts"

echo "" >> /tmp/business_logic_comparison.txt
echo "## NURSE APP" >> /tmp/business_logic_comparison.txt
echo "================================" >> /tmp/business_logic_comparison.txt
echo "" >> /tmp/business_logic_comparison.txt

# Nurse app files
compare_files "NURSE" "appointment-service.ts" \
    "$ORIGINAL_BASE/kloqo-nurse/src/lib/appointment-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/appointment-service.ts"

compare_files "NURSE" "status-update-service.ts" \
    "$ORIGINAL_BASE/kloqo-nurse/src/lib/status-update-service.ts" \
    "$CURRENT_BASE/apps/nurse-app/src/lib/status-update-service.ts"

compare_files "NURSE" "patient-service.ts" \
    "$ORIGINAL_BASE/kloqo-nurse/src/lib/patient-service.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/patient-service.ts"

compare_files "NURSE" "notification-service.ts" \
    "$ORIGINAL_BASE/kloqo-nurse/src/lib/notification-service.ts" \
    "$CURRENT_BASE/apps/nurse-app/src/lib/notification-service.ts"

compare_files "NURSE" "break-helpers.ts" \
    "$ORIGINAL_BASE/kloqo-nurse/src/lib/break-helpers.ts" \
    "$CURRENT_BASE/packages/shared-core/src/utils/break-helpers.ts"

compare_files "NURSE" "walk-in-scheduler.ts" \
    "$ORIGINAL_BASE/kloqo-nurse/src/lib/walk-in-scheduler.ts" \
    "$CURRENT_BASE/packages/shared-core/src/services/walk-in-scheduler.ts"

echo "" >> /tmp/business_logic_comparison.txt
echo "## FILES ONLY IN ORIGINAL (POTENTIALLY MISSING)" >> /tmp/business_logic_comparison.txt
echo "================================" >> /tmp/business_logic_comparison.txt
echo "" >> /tmp/business_logic_comparison.txt

# Check for files that exist in original but not in current
find "$ORIGINAL_BASE/kloqo-app/src/lib" -name "*.ts" -type f | while read file; do
    filename=$(basename "$file")
    if [ ! -f "$CURRENT_BASE/apps/patient-app/src/lib/$filename" ] && \
       [ ! -f "$CURRENT_BASE/packages/shared-core/src/services/$filename" ] && \
       [ ! -f "$CURRENT_BASE/packages/shared-core/src/utils/$filename" ]; then
        echo "PATIENT: $filename - NOT FOUND in current" >> /tmp/business_logic_comparison.txt
    fi
done

find "$ORIGINAL_BASE/kloqo-clinic-admin/src/lib" -name "*.ts" -type f | while read file; do
    filename=$(basename "$file")
    if [ ! -f "$CURRENT_BASE/apps/clinic-admin/src/lib/$filename" ] && \
       [ ! -f "$CURRENT_BASE/packages/shared-core/src/services/$filename" ] && \
       [ ! -f "$CURRENT_BASE/packages/shared-core/src/utils/$filename" ]; then
        echo "CLINIC: $filename - NOT FOUND in current" >> /tmp/business_logic_comparison.txt
    fi
done

find "$ORIGINAL_BASE/kloqo-nurse/src/lib" -name "*.ts" -type f | while read file; do
    filename=$(basename "$file")
    if [ ! -f "$CURRENT_BASE/apps/nurse-app/src/lib/$filename" ] && \
       [ ! -f "$CURRENT_BASE/packages/shared-core/src/services/$filename" ] && \
       [ ! -f "$CURRENT_BASE/packages/shared-core/src/utils/$filename" ]; then
        echo "NURSE: $filename - NOT FOUND in current" >> /tmp/business_logic_comparison.txt
    fi
done

cat /tmp/business_logic_comparison.txt

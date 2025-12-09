#!/bin/bash

# Find commented-out code (not documentation comments)
# This looks for lines that start with // and contain code patterns like:
# - function calls: someFunction(
# - variable assignments: const/let/var
# - conditionals: if/else/for/while
# - object/array access: .something or [something]

echo "=== COMMENTED-OUT CODE REPORT ===" > /tmp/commented_code_report.txt
echo "Generated: $(date)" >> /tmp/commented_code_report.txt
echo "" >> /tmp/commented_code_report.txt

find_commented_code() {
    local dir=$1
    local app_name=$2
    
    echo "## $app_name" >> /tmp/commented_code_report.txt
    echo "================================" >> /tmp/commented_code_report.txt
    echo "" >> /tmp/commented_code_report.txt
    
    # Find files with potential commented-out code
    find "$dir" -name "*.ts" -o -name "*.tsx" | grep -v node_modules | while read file; do
        # Look for commented lines that look like code (not documentation)
        commented_lines=$(grep -n "^[[:space:]]*\/\/ [a-z]" "$file" | \
            grep -E "(const |let |var |function |if\(|else|for\(|while\(|return |await |async |\(.*\)|\..*\(|import |export )" | \
            grep -v "CRITICAL\|TODO\|NOTE\|FIXME\|HACK\|XXX\|BUG" | \
            head -5)
        
        if [ ! -z "$commented_lines" ]; then
            rel_path=$(echo "$file" | sed "s|/Users/jinodevasia/Desktop/Kloqo-Production/||")
            echo "File: $rel_path" >> /tmp/commented_code_report.txt
            echo "$commented_lines" >> /tmp/commented_code_report.txt
            echo "" >> /tmp/commented_code_report.txt
        fi
    done
    
    echo "" >> /tmp/commented_code_report.txt
}

# Check shared-core
find_commented_code "/Users/jinodevasia/Desktop/Kloqo-Production/packages/shared-core/src" "SHARED-CORE"

# Check apps
find_commented_code "/Users/jinodevasia/Desktop/Kloqo-Production/apps/patient-app/src" "PATIENT-APP"
find_commented_code "/Users/jinodevasia/Desktop/Kloqo-Production/apps/nurse-app/src" "NURSE-APP"
find_commented_code "/Users/jinodevasia/Desktop/Kloqo-Production/apps/clinic-admin/src" "CLINIC-ADMIN"

cat /tmp/commented_code_report.txt

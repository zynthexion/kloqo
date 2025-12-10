#!/bin/bash
echo "🔍 Analyzing Nurse App Bundle..."
ANALYZE=true npm run build
echo "📊 Bundle analysis complete! Check .next/analyze/ for results."

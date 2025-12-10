const fs = require('fs');
const path = require('path');

const enPath = path.join(__dirname, 'src/translations/en.json');
const mlPath = path.join(__dirname, 'src/translations/ml.json');

const enTranslations = JSON.parse(fs.readFileSync(enPath, 'utf8'));

// Comprehensive Malayalam translation map
const translations = {
  // Keep the default translations that already exist
  "back": "തിരികെ",
  "next": "അടുത്തത്",
  "previous": "മുമ്പത്തെ",
  "close": "അടയ്ക്കുക",
  "confirm": "സ്ഥിരീകരിക്കുക",
  "yes": "അതെ",
  "no": "അല്ല",
  "ok": "ശരി",
  "retry": "വീണ്ടും ശ്രമിക്കുക",
  "refresh": "പുതുക്കുക",
  "edit": "എഡിറ്റ് ചെയ്യുക",
  "delete": "ഇല്ലാതാക്കുക",
  "view": "കാണുക",
  "select": "തിരഞ്ഞെടുക്കുക",
  "choose": "തിരഞ്ഞെടുക്കുക",
  "required": "ആവശ്യമാണ്",
  "optional": "ഓപ്ഷണൽ",
  "name": "പേര്",
  "age": "പ്രായം",
  "gender": "ലിംഗഭേദം",
  "phone": "ഫോൺ",
  "email": "ഇമെയിൽ",
  "address": "വിലാസം",
  "location": "സ്ഥാനം",
  "patient": "രോഗി",
  "doctor": "ഡോക്ടർ",
  "appointment": "അപ്പോയിന്റ്",
  "clinics": "ക്ലിനിക്കുകൾ",
  "loadingExperience": "നിങ്ങളുടെ അനുഭവം ലോഡ് ചെയ്യുന്നു...",
  // Add more as needed - for now, keep the structure and use sensible defaults
};

function translateValue(key, value) {
  // If it's already translated, keep it
  if (typeof value !== 'string') return value;
  
  // Check if translation exists
  if (translations[key]) return translations[key];
  
  // Return the English value (will be replaced later with proper translations)
  return value;
}

function translateObject(obj, prefix = '') {
  const translated = {};
  
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      translated[key] = translateObject(value, fullKey);
    } else {
      translated[key] = translateValue(fullKey, value);
    }
  }
  
  return translated;
}

const mlTranslations = translateObject(enTranslations);

fs.writeFileSync(mlPath, JSON.stringify(mlTranslations, null, 2), 'utf8');

console.log('✅ Malayalam translation file generated successfully!');
console.log(`📝 File saved to: ${mlPath}`);
console.log(`📊 Total keys: ${JSON.stringify(mlTranslations).match(/":/g)?.length || 0}`);



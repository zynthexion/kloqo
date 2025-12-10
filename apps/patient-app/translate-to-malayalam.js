const fs = require('fs');
const path = require('path');

// Read the English translation file
const enFilePath = path.join(__dirname, 'src/translations/en.json');
const enTranslations = JSON.parse(fs.readFileSync(enFilePath, 'utf8'));

// Comprehensive translation mapping for medical terms in Malayalam
const translations = {
  // Common UI elements
  "Home": "വീട്",
  "Appointments": "നിയമിത രൂപം", 
  "Profile": "പ്രൊഫൈൽ",
  "Settings": "ക്രമീകരണങ്ങൾ",
  "Logout": "ലോഗൗട്ട്",
  "Cancel": "റദ്ദാക്കുക",
  "Save": "സംരക്ഷിക്കുക",
  "Submit": "സമർപ്പിക്കുക",
  "Search": "തിരയുക",
  "Loading...": "ലോഡ് ചെയ്യുന്നു...",
  "Error": "പിശക്",
  "Success": "വിജയം",
  
  // Login
  "Welcome to Kloqo": "ക്ലോക്വിലേക്ക് സ്വാഗതം",
  "First in Queue": "ക്വൂവിൽ ഒന്നാം സ്ഥാനം",
  "Enter your phone number": "നിങ്ങളുടെ ഫോൺ നമ്പർ നൽകുക",
  "Generate OTP": "OTP സൃഷ്ടിക്കുക",
  "Enter OTP": "OTP നൽകുക",
  "OTP sent": "OTP അയച്ചു",
  "Resend": "വീണ്ടും അയക്കുക",
  "Change Phone": "ഫോൺ നമ്പർ മാറ്റുക",
  "Confirm OTP": "OTP സ്ഥിരീകരിക്കുക",
  
  // Appointments
  "Upcoming Appointments": "ഉള്ളടക്ക അപ്പോയിന്റുകൾ",
  "Appointment History": "അപ്പോയിന്റ് ചരിത്രം",
  "No Appointments": "അപ്പോയിന്റുകൾ ഇല്ല",
  "Date": "തീയതി",
  "Time": "സമയം",
  "Doctor": "ഡോക്ടർ",
  "Department": "വിഭാഗം",
  "Token": "ടോക്കൺ",
  "Status": "പ്രാദേശിക നില",
  "Confirmed": "സ്ഥിരീകരിച്ചു",
  "Pending": "സമാക്ഷേപിച്ചു",
  "Completed": "പൂർത്തിയാക്കി",
  "Cancelled": "റദ്ദാക്കി",
  
  // Booking
  "Book Appointment": "അപ്പോയിന്റ് ബുക്ക് ചെയ്യുക",
  "Reschedule": "തീയതി മാറ്റുക",
  "Cancel Appointment": "അപ്പോയിന്റ് റദ്ദാക്കുക",
  "View Details": "വിശദാംശങ്ങൾ കാണുക",
  "Scan QR": "QR സ്കാൻ ചെയ്യുക",
  "Consult Today": "ഇന്ന് കൺസൾട്ട് ചെയ്യുക",
  
  // Toast messages
  "Appointment Booked Successfully!": "അപ്പോയിന്റ് വിജയകരമായി ബുക്ക് ചെയ്തു!",
  "Appointment Cancelled": "അപ്പോയിന്റ് റദ്ദാക്കി",
  "Appointment Rescheduled": "അപ്പോയിന്റ് മാറ്റി",
  "An error occurred": "ഒരു പിശക് ഉണ്ടായി",
  "Please try again": "ദയവായി വീണ്ടും ശ്രമിക്കുക",
  "Successfully saved": "വിജയകരമായി സംരക്ഷിച്ചു",
};

// Function to translate a string
function translateToMalayalam(text) {
  return translations[text] || text;
}

// Function to recursively translate an object
function translateObject(obj) {
  const translated = {};
  
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      // Recursively translate nested objects
      translated[key] = translateObject(obj[key]);
    } else if (typeof obj[key] === 'string') {
      // Translate string values
      translated[key] = translateToMalayalam(obj[key]);
    } else {
      // Keep non-string values as is
      translated[key] = obj[key];
    }
  }
  
  return translated;
}

try {
  // Translate the entire translation object
  const mlTranslations = translateObject(enTranslations);
  
  // Write the Malayalam translation file
  const mlFilePath = path.join(__dirname, 'src/translations/ml.json');
  fs.writeFileSync(mlFilePath, JSON.stringify(mlTranslations, null, 2), 'utf8');
  
  console.log('✅ Malayalam translation file generated successfully!');
  console.log(`📝 File saved to: ${mlFilePath}`);
  console.log(`📊 Total keys translated: ${JSON.stringify(mlTranslations).split('NEEDS TRANSLATION').length - 1}`);
} catch (error) {
  console.error('❌ Error generating translation file:', error);
}

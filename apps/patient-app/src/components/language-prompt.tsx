'use client';

import { useState, useEffect } from 'react';
import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/language-context';
import translations from '@/translations';

export function LanguagePrompt() {
  const [showPrompt, setShowPrompt] = useState(false); // Start with false, check after mount
  const [isMounted, setIsMounted] = useState(false);
  const { setLanguage } = useLanguage();
  
  // Use English translations as default since language isn't selected yet
  const t = translations.en;

  useEffect(() => {
    // Wait for client-side to ensure localStorage is available
    setIsMounted(true);
    
    // Check if language has been selected before
    const savedLanguage = localStorage.getItem('app-language');
    
    // If language is already selected, don't show prompt
    if (savedLanguage && (savedLanguage === 'en' || savedLanguage === 'ml')) {
      setShowPrompt(false);
      return;
    }
    
    // Language not selected - show prompt
    setShowPrompt(true);
  }, []);

  // Don't render until mounted to avoid hydration issues
  if (!isMounted) {
    return (
      <div className="fixed inset-0 bg-white z-[9999] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
      </div>
    );
  }

  const handleSelectLanguage = (lang: 'en' | 'ml') => {
    setLanguage(lang);
    setShowPrompt(false);
    localStorage.setItem('language-prompt-shown', 'true');
  };

  // Must select language - no dismiss option on first load
  if (!showPrompt) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <Card className="w-full max-w-md animate-in fade-in-50 slide-in-from-bottom-10 shadow-2xl">
        <CardContent className="p-8">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Languages className="w-8 h-8 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-xl">{t.language.title}</h3>
            </div>
          </div>

          <div className="space-y-4">
            <Button
              className="w-full h-16 text-lg font-semibold bg-primary hover:bg-primary/90"
              onClick={() => handleSelectLanguage('en')}
            >
              <span className="text-3xl mr-3">🇬🇧</span>
              {t.language.english}
            </Button>
            <Button
              variant="outline"
              className="w-full h-16 text-lg font-semibold border-2 hover:bg-accent"
              onClick={() => handleSelectLanguage('ml')}
            >
              <span className="text-3xl mr-3">🇮🇳</span>
              <span className="font-malayalam">{t.language.malayalam}</span>
            </Button>
          </div>

          <p className="text-xs text-muted-foreground text-center mt-6">
            {t.language.description}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}


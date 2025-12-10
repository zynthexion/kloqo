'use client';

import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/language-context';
import { useToast } from '@/hooks/use-toast';

export function LanguageSettings() {
  const { language, setLanguage, t } = useLanguage();
  const { toast } = useToast();

  const handleLanguageChange = (lang: 'en' | 'ml') => {
    setLanguage(lang);
    toast({
      title: t.messages.success,
      description: t.language.languageChanged,
    });
  };

  return (
    <div className="flex items-center justify-between p-4 border-b last:border-b-0">
      <div className="flex items-center gap-4 flex-1">
        <Languages className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <p className="font-semibold">{t.profile.language}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant={language === 'en' ? 'default' : 'outline'}
          size="sm"
          onClick={() => handleLanguageChange('en')}
          className="px-3"
        >
          🇬🇧 English
        </Button>
        <Button
          variant={language === 'ml' ? 'default' : 'outline'}
          size="sm"
          onClick={() => handleLanguageChange('ml')}
          className="px-3"
        >
          🇮🇳 മലയാളം
        </Button>
      </div>
    </div>
  );
}


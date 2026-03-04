'use client';

import { useState, useEffect } from 'react';
import { LottieAnimation } from './lottie-animation';

export function MagicLinkOverlay() {
    const [animationData, setAnimationData] = useState<any>(null);

    useEffect(() => {
        // Dynamically import animation to avoid static JSON module resolution issues in PWA/webpack builds
        import('@/lib/animations/cat_sneaking.json').then((mod) => {
            setAnimationData(mod.default ?? mod);
        });
    }, []);

    return (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-white/80 backdrop-blur-md animate-in fade-in duration-500">
            <div className="flex flex-col items-center space-y-8 p-6 text-center max-w-sm">
                <div className="relative min-h-[250px] flex items-center justify-center">
                    {animationData ? (
                        <LottieAnimation
                            animationData={animationData}
                            size={250}
                            autoplay={true}
                            loop={true}
                        />
                    ) : (
                        <div className="w-[250px] h-[250px] animate-pulse bg-gray-100 rounded-full" />
                    )}
                </div>

                <div className="space-y-4">
                    <h2 className="text-2xl font-bold text-gray-900 leading-tight">
                        ദയവായി കാത്തിരിക്കുക...
                    </h2>

                    <div className="space-y-2">
                        <p className="text-lg font-medium text-gray-700">
                            നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് വിവരങ്ങൾ ലഭ്യമാക്കുന്നു.
                        </p>
                        <p className="text-sm text-gray-500 font-semibold animate-pulse">
                            ആപ്പ് ക്ലോസ് ചെയ്യുകയോ ബാക്ക് ബട്ടൺ അമർത്തുകയോ ചെയ്യരുത്.
                        </p>
                    </div>
                </div>

                <div className="flex space-x-2">
                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" />
                </div>
            </div>
        </div>
    );
}

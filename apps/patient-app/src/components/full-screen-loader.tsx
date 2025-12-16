'use client';

import React from 'react';
import { LottieAnimation } from './lottie-animation';
import sandyLoadingAnimation from '@/lib/animations/sandy_loading.json';

interface FullScreenLoaderProps {
    isOpen: boolean;
}

export function FullScreenLoader({ isOpen }: FullScreenLoaderProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[50] flex items-center justify-center bg-background/80 backdrop-blur-sm touch-none">
            <div className="flex justify-center w-[80vw] max-w-[400px]">
                <LottieAnimation
                    animationData={sandyLoadingAnimation}
                    size={300}
                    loop={true}
                    autoplay={true}
                />
            </div>
        </div>
    );
}

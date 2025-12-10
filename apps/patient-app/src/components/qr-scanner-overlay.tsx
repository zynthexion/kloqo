'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type ScanMode = 'consult' | 'confirm' | null;

interface QrScannerOverlayProps {
  open: boolean;
  mode: ScanMode;
  title: string;
  description: string;
  onClose: () => void;
  onScan: (decodedText: string) => void;
}

type Html5QrcodeModule = typeof import('html5-qrcode');

let cachedHtml5Module: Html5QrcodeModule | null = null;

export function QrScannerOverlay({
  open,
  mode,
  title,
  description,
  onClose,
  onScan,
}: QrScannerOverlayProps) {
  const containerId = useId().replace(/:/g, '');
  const scannerRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const hasScannedRef = useRef(false);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch {
        // ignore stop errors
      }
      try {
        scannerRef.current.clear();
      } catch {
        // ignore clear errors
      }
      scannerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setError(null);
      hasScannedRef.current = false;
      return;
    }

    let canceled = false;
    setIsStarting(true);

    async function startScanner() {
      try {
        if (!cachedHtml5Module) {
          cachedHtml5Module = await import('html5-qrcode');
        }

        // Ensure DOM has rendered the target container
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

        if (canceled) return;

        const { Html5Qrcode } = cachedHtml5Module;
        scannerRef.current = new Html5Qrcode(containerId, { verbose: false });
        
        // Reset scan flag when starting
        hasScannedRef.current = false;
        
        await scannerRef.current.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
          },
          (decodedText: string) => {
            // Only process first scan to prevent multiple callbacks
            if (!hasScannedRef.current) {
              hasScannedRef.current = true;
              // Stop scanner immediately after first successful scan
              scannerRef.current?.stop().catch(() => {
                // Ignore stop errors
              });
              onScan(decodedText);
            }
          },
          () => {
            // ignore scan errors
          }
        );
        if (!canceled) {
          setError(null);
        }
      } catch (err) {
        console.error('QR scanner failed to start', err);
        if (!canceled) {
          if (err instanceof Error && /Permission denied/i.test(err.message)) {
            setError('Camera permission was denied. Please allow camera access in your browser settings.');
          } else if (err instanceof Error && /not found/i.test(err.message)) {
            setError('Unable to initialize the camera preview. Please try again.');
          } else {
            setError('Unable to access the camera. Please try again.');
          }
        }
      } finally {
        if (!canceled) {
          setIsStarting(false);
        }
      }
    }

    startScanner();

    return () => {
      canceled = true;
      setIsStarting(false);
      stopScanner();
    };
  }, [open, containerId, onScan, stopScanner]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-[1000] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl relative">
        <div className="flex justify-between items-center mb-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">{mode === 'confirm' ? 'Confirm Arrival' : 'Consult'}</p>
            <h3 className="text-xl font-bold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="rounded-2xl border border-muted bg-muted/20 p-4 min-h-[280px] flex items-center justify-center relative overflow-hidden">
          <div
            id={containerId}
            className={`w-full rounded-xl bg-black transition-opacity duration-200 ${isStarting ? 'opacity-0' : 'opacity-100'}`}
          />
          {isStarting && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/80 rounded-2xl">
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
          )}
        </div>

        {error ? (
          <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
            {error}
          </div>
        ) : (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Hold the QR code steady inside the frame to scan automatically.
          </p>
        )}
      </div>
    </div>
  );
}


'use client';

import { useEffect } from 'react';
import { errorEmitter } from '@kloqo/shared-core';
import type { FirestorePermissionError } from '@kloqo/shared-core';
import { useToast } from '@/hooks/use-toast';

export default function FirebaseErrorListener() {
  const { toast } = useToast();

  useEffect(() => {
    const handlePermissionError = (error: FirestorePermissionError) => {
      console.error(
        'Firestore Permission Error Context:',
        JSON.stringify(error.context, null, 2)
      );
      toast({
        variant: 'destructive',
        title: 'Firestore Permission Error',
        description: 'Check the browser console for detailed context about the security rule violation.',
        duration: 10000,
      });
      // By throwing the error, we let Next.js Development Overlay display it.
      // This is intentional for a better debugging experience.
      throw error;
    };

    errorEmitter.on('permission-error', handlePermissionError);

    return () => {
      errorEmitter.removeListener('permission-error', handlePermissionError);
    };
  }, [toast]);

  return null;
}

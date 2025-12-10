import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '.next/',
        'dist/',
        '**/*.config.{ts,js}',
        '**/types.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@kloqo/shared-core': path.resolve(__dirname, './packages/shared-core/src'),
      '@kloqo/shared-types': path.resolve(__dirname, './packages/shared-types/src'),
      '@kloqo/shared-firebase': path.resolve(__dirname, './packages/shared-firebase/src'),
    },
  },
});


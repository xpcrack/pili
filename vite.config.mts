import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = __dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': repoRoot,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3005,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 3005,
    strictPort: true,
  },
  build: {
    outDir: path.join(repoRoot, 'dist/client'),
    emptyOutDir: true,
  },
});

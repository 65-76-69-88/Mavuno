import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  resolve: { alias: { '@pricemesh/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)) } },
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022', rollupOptions: { treeshake: false } },
  worker: { format: 'es', rollupOptions: { treeshake: false } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001', '/packs': 'http://127.0.0.1:3001', '/health': 'http://127.0.0.1:3001' } }
});

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5200, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: 'index.html', multiplayer: 'multiplayer.html' } },
  },
});

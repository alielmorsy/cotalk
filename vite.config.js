import { defineConfig } from 'vite';

export default defineConfig({
  root: 'dashboard',
  base: '/dashboard/',
  build: {
    outDir: '../daemon/public',
    emptyOutDir: true,
  },
  server: {
    // same host as the daemon, so the sign-in cookie from 127.0.0.1:7878 reaches the dev server
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:7878',
      '/mcp': 'http://127.0.0.1:7878',
      '/events': 'http://127.0.0.1:7878',
      '/health': 'http://127.0.0.1:7878',
    },
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  root: 'dashboard',
  base: '/dashboard/',
  build: {
    outDir: '../daemon/public',
    emptyOutDir: true,
  },
  server: {
    // same host as the daemon, so the sign-in cookie from 127.0.0.1:7777 reaches the dev server
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/mcp': 'http://127.0.0.1:7777',
      '/events': 'http://127.0.0.1:7777',
      '/health': 'http://127.0.0.1:7777',
    },
  },
});

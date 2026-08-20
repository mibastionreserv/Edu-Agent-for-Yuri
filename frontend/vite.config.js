import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Render injects RENDER_GIT_COMMIT at build time; embedding it lets deploy
// tooling verify a fresh bundle shipped just by checking the browser console
// or the JS chunk hash (SS-32).
const appCommit = process.env.RENDER_GIT_COMMIT || 'unknown';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(appCommit),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/content': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{js,jsx}'],
  },
});

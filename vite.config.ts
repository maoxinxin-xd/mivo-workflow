import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ensureLocalService, serviceUrl } from './server/bootstrap';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'mivo-local-service',
      async configureServer() {
        await ensureLocalService();
      },
    },
  ],
  server: {
    port: 9530,
    strictPort: true,
    host: '127.0.0.1',
    proxy: Object.fromEntries(
      ['/local-api', '/mivo', '/llm'].map((path) => [
        path,
        { target: serviceUrl, changeOrigin: true },
      ]),
    ),
  },
});

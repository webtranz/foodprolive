import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  plugins: [
    react(),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001'
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  }
});

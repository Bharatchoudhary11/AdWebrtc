import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => ({
  plugins: [react()],
  root: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022'
  },
  define: {
    'import.meta.env.VITE_MODE': JSON.stringify(process.env.MODE || 'wasm')
  }
}))

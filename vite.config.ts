import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  publicDir: 'docs',
  build: {
    outDir: 'docs',
    emptyOutDir: false,
    copyPublicDir: false,  // docs/ is outDir — don't copy it into itself
  },
})

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true
  },
  resolve: {
    alias: {
      '@': resolve('src'),
      '@renderer': resolve('src/renderer'),
      '@main': resolve('src/main'),
      '@preload': resolve('src/preload')
    }
  }
})

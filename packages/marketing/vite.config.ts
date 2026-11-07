import { defineConfig } from 'vite'
import { sitePlugin } from './src/vite-plugin'

export default defineConfig({
  plugins: [sitePlugin()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 650
  }
})

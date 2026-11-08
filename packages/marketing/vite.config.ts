import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { sitePlugin } from './src/vite-plugin'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [sitePlugin()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        rules: resolve(root, 'rules.html'),
        ledger: resolve(root, 'ledger.html'),
        policies: resolve(root, 'policies.html')
      }
    }
  }
})

/**
 * Vite config for the Node.js web server build.
 * Aliases "electron" → the shim so all ipcMain.handle calls populate webRegistry.
 */
import path from 'node:path'

import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'out/server',
    ssr: true,
    target: 'node24',
    rollupOptions: {
      input: 'src/server/index.ts',
      external: [
        // Keep native addons and heavy AWS SDK as external — loaded from node_modules at runtime
        'node-pty',
        /^node:/,
        /^@aws-sdk\//,
        'adm-zip',
        'express',
        'ws'
      ],
      output: {
        format: 'esm',
        entryFileNames: 'index.mjs'
      }
    }
  },
  resolve: {
    alias: {
      // This is the key: replace 'electron' with our shim for the server build
      electron: path.resolve(__dirname, 'src/server/electronShim.ts'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  ssr: {
    noExternal: [
      // Bundle these so they resolve with the shim
      /src\/main\//
    ]
  }
})

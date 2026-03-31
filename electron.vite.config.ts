import path from 'node:path'
import { execSync } from 'node:child_process'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function readBuildHash(): string {
  const explicit = process.env.AWS_LENS_BUILD_HASH?.trim()

  if (explicit) {
    return explicit.slice(0, 12)
  }

  try {
    return execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const buildHash = readBuildHash()
const releaseChannel = process.env.AWS_LENS_RELEASE_CHANNEL?.trim() || ''

export default defineConfig({
  main: {
    define: {
      __AWS_LENS_BUILD_HASH__: JSON.stringify(buildHash),
      __AWS_LENS_RELEASE_CHANNEL__: JSON.stringify(releaseChannel)
    },
    build: {
      rollupOptions: {
        external: ['node-pty']
      }
    },
    resolve: {
      alias: {
        '@main': path.resolve(__dirname, 'src/main'),
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __AWS_LENS_BUILD_HASH__: JSON.stringify(buildHash),
      __AWS_LENS_RELEASE_CHANNEL__: JSON.stringify(releaseChannel)
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    plugins: [react()],
    define: {
      __AWS_LENS_BUILD_HASH__: JSON.stringify(buildHash),
      __AWS_LENS_RELEASE_CHANNEL__: JSON.stringify(releaseChannel)
    },
    resolve: {
      alias: {
        '@renderer': path.resolve(__dirname, 'src/renderer/src'),
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    }
  }
})

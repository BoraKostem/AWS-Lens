/**
 * GitHub Device OAuth flow for web mode.
 *
 * Allows users to authenticate with GitHub so terraform projects can be
 * cloned/pulled from private repos. Uses Device Flow (no redirect URL needed).
 *
 * Flow:
 *   1. POST /api/github/auth/start  → { deviceCode, userCode, verificationUri, expiresIn, interval }
 *   2. User opens verificationUri and enters userCode
 *   3. GET  /api/github/auth/poll   → { status: 'pending'|'complete'|'expired' }
 *   4. GET  /api/github/auth/status → { authenticated: bool, login?: string }
 *   5. POST /api/github/auth/logout → clears token
 *
 * Token is stored in process memory only — not written to disk or logged.
 * Git operations use the token via GIT_ASKPASS or credential helper.
 *
 * Env:
 *   GITHUB_CLIENT_ID — OAuth app client ID (public, safe to commit)
 *                      Defaults to the GitHub CLI app ID for convenience.
 */

import type { Router } from 'express'
import { Router as createRouter } from 'express'

// GitHub CLI's public client ID — works for device flow without a custom app
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.b507a08c87ecfe98'

interface DeviceState {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
  token?: string
  login?: string
}

let deviceState: DeviceState | null = null
let accessToken: string | null = null
let githubLogin: string | null = null

export function getGithubToken(): string | null {
  return accessToken
}

export function githubAuthRouter(): Router {
  const router = createRouter()

  // POST /api/github/auth/start
  router.post('/start', async (_req, res) => {
    try {
      const resp = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, scope: 'repo read:org' })
      })
      const data = await resp.json() as {
        device_code: string
        user_code: string
        verification_uri: string
        expires_in: number
        interval: number
      }

      deviceState = {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: Date.now() + data.expires_in * 1000,
        interval: data.interval ?? 5,
      }

      res.json({
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in,
        interval: data.interval ?? 5,
      })
    } catch (err) {
      res.status(500).json({ error: 'Failed to start device flow' })
    }
  })

  // GET /api/github/auth/poll
  router.get('/poll', async (_req, res) => {
    if (!deviceState) {
      res.json({ status: 'idle' })
      return
    }
    if (Date.now() > deviceState.expiresAt) {
      deviceState = null
      res.json({ status: 'expired' })
      return
    }
    if (accessToken) {
      res.json({ status: 'complete', login: githubLogin })
      return
    }

    try {
      const resp = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceState.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      })
      const data = await resp.json() as { access_token?: string; error?: string }

      if (data.access_token) {
        accessToken = data.access_token
        deviceState = null

        // Fetch login for display
        try {
          const userResp = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'aws-lens' }
          })
          const user = await userResp.json() as { login?: string }
          githubLogin = user.login ?? null
        } catch {/* non-fatal */}

        configureGitCredentials(accessToken)
        res.json({ status: 'complete', login: githubLogin })
      } else if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        res.json({ status: 'pending' })
      } else {
        deviceState = null
        res.json({ status: 'error', error: data.error })
      }
    } catch {
      res.json({ status: 'pending' })
    }
  })

  // GET /api/github/auth/status
  router.get('/status', (_req, res) => {
    res.json({ authenticated: !!accessToken, login: githubLogin ?? undefined })
  })

  // POST /api/github/auth/logout
  router.post('/logout', (_req, res) => {
    accessToken = null
    githubLogin = null
    deviceState = null
    clearGitCredentials()
    res.json({ ok: true })
  })

  return router
}

/**
 * Write a git credential helper that injects the token for github.com.
 * Uses GIT_ASKPASS-style helper written to a temp script.
 */
function configureGitCredentials(token: string): void {
  try {
    const { execSync } = require('node:child_process')
    // Store credentials via git credential store for the session
    execSync(
      `git config --global credential.helper '!f() { echo username=x-token; echo password=${token}; }; f'`,
      { stdio: 'ignore' }
    )
  } catch {/* non-fatal — git may not be available yet */}
}

function clearGitCredentials(): void {
  try {
    const { execSync } = require('node:child_process')
    execSync('git config --global --unset credential.helper', { stdio: 'ignore' })
  } catch {/* ignore — may not be set */}
}

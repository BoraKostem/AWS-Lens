/**
 * Regression test: all push-style (subscribe/unsubscribe) methods declared
 * in the Window['awsLens'] and Window['terraformWorkspace'] interfaces must
 * be present in webBridge so they don't crash in web mode.
 *
 * The error "bridge$1(...).subscribeTempVolumeProgress is not a function"
 * was caused by missing push method implementations. This test catches that.
 */

import { describe, it, expect } from 'vitest'
import { webBridge } from '../webBridge'

// Push-style methods declared in vite-env.d.ts Window['awsLens']
const REQUIRED_AWSLENS_PUSH_METHODS = [
  'subscribeTerminal',
  'unsubscribeTerminal',
  'subscribeTempVolumeProgress',
  'unsubscribeTempVolumeProgress',
  'onTerminalEvent',
  'offTerminalEvent',
] as const

// Push-style methods declared in Window['terraformWorkspace']
// (webBridge is assigned to both window.awsLens and window.terraformWorkspace)
const REQUIRED_TERRAFORM_PUSH_METHODS = [
  'subscribe',
  'unsubscribe',
] as const

describe('webBridge push methods', () => {
  it.each(REQUIRED_AWSLENS_PUSH_METHODS)(
    'window.awsLens.%s must be a function',
    (method) => {
      expect(typeof (webBridge as Record<string, unknown>)[method]).toBe('function')
    }
  )

  it.each(REQUIRED_TERRAFORM_PUSH_METHODS)(
    'window.terraformWorkspace.%s must be a function',
    (method) => {
      expect(typeof (webBridge as Record<string, unknown>)[method]).toBe('function')
    }
  )
})

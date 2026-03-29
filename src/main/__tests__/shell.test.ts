import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// shell.ts uses process.platform and process.env — mock before import
const originalPlatform = process.platform
const originalEnv = { ...process.env }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('quotePosix (via quoteShellValue on posix)', async () => {
  beforeEach(() => {
    setPlatform('linux')
    process.env.SHELL = '/bin/bash'
  })

  it('wraps value in single quotes', async () => {
    const { quoteShellValue } = await import('@main/shell')
    expect(quoteShellValue('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', async () => {
    const { quoteShellValue } = await import('@main/shell')
    expect(quoteShellValue("it's")).toBe("'it'\\''s'")
  })

  it('handles empty string', async () => {
    const { quoteShellValue } = await import('@main/shell')
    expect(quoteShellValue('')).toBe("''")
  })

  it('preserves spaces and special chars that do not need escaping', async () => {
    const { quoteShellValue } = await import('@main/shell')
    expect(quoteShellValue('hello world')).toBe("'hello world'")
    expect(quoteShellValue('foo$bar')).toBe("'foo$bar'")
  })
})

describe('getShellConfig', async () => {
  it('returns posix config on linux', async () => {
    setPlatform('linux')
    process.env.SHELL = '/bin/zsh'
    const { getShellConfig } = await import('@main/shell')
    const config = getShellConfig()
    expect(config.kind).toBe('posix')
    expect(config.command).toBe('/bin/zsh')
  })

  it('returns posix config on darwin', async () => {
    setPlatform('darwin')
    delete process.env.SHELL
    const { getShellConfig } = await import('@main/shell')
    const config = getShellConfig()
    expect(config.kind).toBe('posix')
    expect(config.command).toBe('/bin/zsh')
  })

  it('returns powershell config on win32', async () => {
    setPlatform('win32')
    const { getShellConfig } = await import('@main/shell')
    const config = getShellConfig()
    expect(config.kind).toBe('powershell')
    expect(config.command).toBe('powershell.exe')
  })
})

describe('getTerminalCwd', async () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    setPlatform(originalPlatform)
  })

  it('prefers USERPROFILE (Windows path)', async () => {
    process.env.USERPROFILE = 'C:\\Users\\test'
    delete process.env.HOME
    const { getTerminalCwd } = await import('@main/shell')
    expect(getTerminalCwd()).toBe('C:\\Users\\test')
  })

  it('falls back to HOME on unix', async () => {
    delete process.env.USERPROFILE
    process.env.HOME = '/home/user'
    const { getTerminalCwd } = await import('@main/shell')
    expect(getTerminalCwd()).toBe('/home/user')
  })
})

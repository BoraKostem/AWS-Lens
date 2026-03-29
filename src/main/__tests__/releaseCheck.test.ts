import { describe, expect, it } from 'vitest'

// Extract the pure helpers by duplicating them — releaseCheck.ts imports
// from 'electron' which is unavailable in the test environment.
function normalizeVersion(value: string): string {
  return value.trim().replace(/^[^\d]*/, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1
    }
  }

  return 0
}

describe('normalizeVersion', () => {
  it('strips leading v prefix', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
  })

  it('strips leading text', () => {
    expect(normalizeVersion('release-1.2.3')).toBe('1.2.3')
  })

  it('trims whitespace', () => {
    expect(normalizeVersion('  1.2.3  ')).toBe('1.2.3')
  })

  it('leaves plain version unchanged', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3')
  })
})

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('returns -1 when left is older', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })

  it('returns 1 when left is newer', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
  })

  it('handles v-prefixed tags', () => {
    expect(compareVersions('0.1.0', 'v0.2.0')).toBe(-1)
    expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0)
  })

  it('handles missing patch segment', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
  })
})

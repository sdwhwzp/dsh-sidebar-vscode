/**
 * The palette payload: colour normalization and the scheme the node half keys on.
 */
import { describe, expect, it } from 'vitest'
import { hex, themePayload } from '../src/client/dshTheme.ts'

/** A body stand-in whose computed style answers a fixed token table. */
function bodyWith(tokens: Record<string, string>, dark = false): HTMLElement {
  const element = {
    hasAttribute: (name: string) => dark && name === 'data-ds-dark-theme',
  } as unknown as HTMLElement
  const style = { getPropertyValue: (name: string) => tokens[name] ?? '' }
  const original = globalThis.getComputedStyle
  ;(globalThis as { getComputedStyle: unknown }).getComputedStyle = () => style
  queueMicrotask(() => { (globalThis as { getComputedStyle: unknown }).getComputedStyle = original })
  return element
}

describe('token colours', () => {
  it('keeps the hex forms VS Code settings accept', () => {
    expect(hex('#FFFFFF')).toBe('#ffffff')
    expect(hex('#0000000a')).toBe('#0000000a')
  })

  it('converts the rgb forms a computed token carries', () => {
    expect(hex('rgb(255, 255, 255)')).toBe('#ffffff')
    expect(hex('rgb(255 255 255)')).toBe('#ffffff')
    expect(hex('rgba(0, 0, 0, 0.04)')).toBe('#0000000a')
  })

  it('answers empty for a value no colour parser accepts', () => {
    expect(hex('')).toBe('')
    expect(hex('not-a-colour')).toBe('')
  })
})

describe('theme payload', () => {
  it('reports the scheme the body attribute carries', () => {
    expect(themePayload(bodyWith({}, true)).scheme).toBe('dark')
    expect(themePayload(bodyWith({}, false)).scheme).toBe('light')
  })

  it('carries a token that resolves and omits one that does not', () => {
    const payload = themePayload(bodyWith({
      '--dsw-alias-bg-base': 'rgb(255, 255, 255)',
      '--dsw-alias-label-secondary': '#61666b',
    }))
    expect(payload.colors['sideBar.background']).toBe('#ffffff')
    expect(payload.colors['sideBar.foreground']).toBe('#61666b')
    // Absent tokens must not reach the settings file as empty strings.
    expect('tab.activeBorderTop' in payload.colors).toBe(false)
  })
})

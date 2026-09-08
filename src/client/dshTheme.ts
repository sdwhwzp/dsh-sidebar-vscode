/**
 * The DSH palette as an editor theme payload.
 *
 * The workbench takes its colours from the account's own settings, which the
 * node half writes: the colour scheme selects the base theme so the code pane
 * and syntax colours follow, and these keys carry the DSH tokens into the
 * chrome around it. Sending nothing leaves the editor on the workbench default,
 * which is how it stops following DSH.
 *
 * @module dsh-sidebar-vscode/client/dshTheme
 */

/** Workbench colour keys taken from DSH tokens, paired with the token each reads. */
const COLOR_TOKENS: readonly (readonly [string, string])[] = [
  ['titleBar.activeBackground', 'bg-base'],
  ['titleBar.activeForeground', 'label-secondary'],
  ['titleBar.border', 'border-l1'],
  ['activityBar.background', 'bg-base'],
  ['activityBar.foreground', 'label-primary'],
  ['activityBar.inactiveForeground', 'label-tertiary'],
  ['activityBar.border', 'border-l1'],
  ['sideBar.background', 'bg-base'],
  ['sideBar.foreground', 'label-secondary'],
  ['sideBar.border', 'border-l1'],
  ['sideBarTitle.foreground', 'label-tertiary'],
  ['sideBarSectionHeader.background', 'bg-base'],
  ['sideBarSectionHeader.foreground', 'label-tertiary'],
  ['sideBarSectionHeader.border', 'border-l1'],
  ['statusBar.background', 'bg-base'],
  ['statusBar.foreground', 'label-tertiary'],
  ['statusBar.border', 'border-l1'],
  ['editorGroupHeader.tabsBackground', 'bg-base'],
  ['editorGroupHeader.tabsBorder', 'border-l1'],
  ['tab.activeBackground', 'bg-layer-2'],
  ['tab.inactiveBackground', 'bg-base'],
  ['tab.activeForeground', 'label-primary'],
  ['tab.inactiveForeground', 'label-tertiary'],
  ['tab.border', 'border-l1'],
  ['tab.activeBorderTop', 'brand-primary'],
  ['tab.hoverBackground', 'interactive-bg-hover'],
  ['list.hoverBackground', 'interactive-bg-hover'],
  ['list.activeSelectionBackground', 'interactive-bg-active'],
  ['list.activeSelectionForeground', 'label-primary'],
  ['list.inactiveSelectionBackground', 'interactive-bg-hover'],
]

const CHANNEL = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/

/**
 * Convert one resolved DSH token to the `#rrggbb[aa]` form VS Code settings take.
 * @param value - the computed token value, `rgb()`/`rgba()` or already hex.
 * @returns the hex colour, or an empty string when the value is neither.
 */
export function hex(value: string): string {
  const byte = (number: number): string =>
    Math.max(0, Math.min(255, Math.round(number))).toString(16).padStart(2, '0')
  const parts = CHANNEL.exec(value)
  if (parts === null) return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) ? value.toLowerCase() : ''
  const alpha = parts[4] === undefined
    ? 'ff'
    : byte(parts[4].endsWith('%') ? Number(parts[4].slice(0, -1)) * 2.55 : Number(parts[4]) * 255)
  return `#${byte(Number(parts[1]))}${byte(Number(parts[2]))}${byte(Number(parts[3]))}${alpha === 'ff' ? '' : alpha}`
}

/** One accepted theme payload: the colour scheme plus the chrome colours. */
export interface ThemePayload {
  readonly scheme: 'dark' | 'light'
  readonly colors: Record<string, string>
}

/**
 * Read the current DSH palette.
 * @param body - the element carrying the theme, the document body by default.
 * @returns the payload the node half validates and writes.
 */
export function themePayload(body: HTMLElement = document.body): ThemePayload {
  const style = getComputedStyle(body)
  const colors: Record<string, string> = {}
  for (const [key, token] of COLOR_TOKENS) {
    const color = hex(style.getPropertyValue(`--dsw-alias-${token}`).trim())
    if (color !== '') colors[key] = color
  }
  return { scheme: body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light', colors }
}

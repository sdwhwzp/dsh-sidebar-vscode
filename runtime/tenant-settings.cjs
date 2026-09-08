'use strict'
/** DSH-owned slice of a tenant's code-server user settings: theme following and chrome trimming. */
const path = require('node:path')
const { mkdir, readFile, rename, stat, writeFile } = require('node:fs/promises')

/** Built-in themes selected by the DSH color scheme; both ship with code-server. */
const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern' }

/**
 * Workbench color keys this plugin drives from DSH tokens. The browser supplies
 * the values, so the set is closed and anything outside it is dropped rather
 * than written into the account's settings file.
 */
const COLOR_KEYS = new Set([
  'titleBar.activeBackground', 'titleBar.activeForeground', 'titleBar.border',
  'activityBar.background', 'activityBar.foreground', 'activityBar.inactiveForeground', 'activityBar.border',
  'sideBar.background', 'sideBar.foreground', 'sideBar.border', 'sideBarTitle.foreground',
  'sideBarSectionHeader.background', 'sideBarSectionHeader.foreground', 'sideBarSectionHeader.border',
  'statusBar.background', 'statusBar.foreground', 'statusBar.border',
  'editorGroupHeader.tabsBackground', 'editorGroupHeader.tabsBorder',
  'tab.activeBackground', 'tab.inactiveBackground', 'tab.activeForeground', 'tab.inactiveForeground',
  'tab.border', 'tab.activeBorderTop', 'tab.hoverBackground',
  'list.hoverBackground', 'list.activeSelectionBackground', 'list.activeSelectionForeground',
  'list.inactiveSelectionBackground',
])

/** Settings key and value each trimmable chrome part maps to. */
const CHROME = {
  menuBar: ['window.menuBarVisibility', 'hidden'],
  activityBar: ['workbench.activityBar.location', 'hidden'],
  statusBar: ['workbench.statusBar.visible', false],
}

/** Every key this plugin owns; each write removes them all before restating the current ones. */
const MANAGED = ['workbench.colorTheme', 'workbench.colorCustomizations', ...Object.values(CHROME).map(pair => pair[0])]

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/

/**
 * Validate one browser-supplied theme payload.
 * @param value - parsed request body, from an authenticated but untrusted browser.
 * @returns the accepted scheme and colors, or undefined when the payload carries no usable theme.
 */
function readTheme(value) {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(THEMES, value.scheme)) return undefined
  const colors = {}
  const supplied = value.colors
  if (supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied)) {
    for (const key of COLOR_KEYS) {
      const color = supplied[key]
      if (typeof color === 'string' && HEX.test(color)) colors[key] = color
    }
  }
  return { scheme: value.scheme, colors }
}

/**
 * Rewrite the DSH-owned keys in one tenant's code-server settings, preserving
 * every key the account set for itself. VS Code watches this file, so a running
 * editor picks the change up without restarting.
 * @param stateRoot - configured editor state root.
 * @param tenant - tenant directory name, already validated by the authorization step.
 * @param theme - accepted payload, or undefined to drop the theme keys and keep only chrome trimming.
 * @param hiddenChrome - chrome parts to hide, from plugin configuration.
 * @returns the settings file path.
 * @throws {SyntaxError} when the account's existing settings file is not JSON; nothing is overwritten.
 */
async function writeSettings(stateRoot, tenant, theme, hiddenChrome) {
  // The root launcher owns the tenant state directory and rejects one it does
  // not own, so this waits for it rather than creating it.
  await stat(path.join(stateRoot, tenant, 'data'))
  const directory = path.join(stateRoot, tenant, 'data', 'user', 'User')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, 'settings.json')
  let text = '{}'
  try { text = await readFile(file, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  // A hand-edited file that is not JSON throws here, before anything is overwritten.
  const settings = JSON.parse(text)
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new SyntaxError('Editor settings file is not a JSON object; DSH left it unchanged')
  }
  for (const key of MANAGED) delete settings[key]
  if (theme !== undefined) {
    settings['workbench.colorTheme'] = THEMES[theme.scheme]
    if (Object.keys(theme.colors).length > 0) settings['workbench.colorCustomizations'] = theme.colors
  }
  for (const part of hiddenChrome) {
    const [key, value] = CHROME[part]
    settings[key] = value
  }
  const staged = file + '.dsh-staged'
  await writeFile(staged, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  await rename(staged, file)
  return file
}

/**
 * Seed one account's git identity in the editor HOME so commits from different
 * DSH accounts are attributable. Written once: an existing file belongs to the
 * account, and DSH never rewrites it. This is a convenience, not an audit
 * control — git takes an author from the command line or the environment.
 * @param stateRoot - configured editor state root.
 * @param tenant - tenant directory name, already validated by the authorization step.
 * @param account - account name, already restricted to the safe character set.
 * @param domain - configured email domain.
 * @returns the git configuration path.
 */
async function seedGitIdentity(stateRoot, tenant, account, domain) {
  const file = path.join(stateRoot, tenant, 'data', '.gitconfig')
  const body = '# Seeded by DSH for this account. Edit freely; DSH will not rewrite it.\n'
    + '[user]\n\tname = ' + account + '\n\temail = ' + account + '@' + domain + '\n'
  try { await writeFile(file, body, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return file
}

/**
 * Create the account's command spool for the companion sidebar plugin. The
 * sandbox reaches it as `/editor-data/dsh-sidebar-vscode`, so the directory
 * must exist before an editor boots; its contents are owned by the two halves
 * of that plugin, not by this one.
 * @param stateRoot - configured editor state root.
 * @param tenant - tenant directory name, already validated by the authorization step.
 * @returns the spool path.
 */
async function ensureSpool(stateRoot, tenant) {
  const directory = path.join(stateRoot, tenant, 'data', 'dsh-sidebar-vscode')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

module.exports = { CHROME, COLOR_KEYS, MANAGED, THEMES, ensureSpool, readTheme, seedGitIdentity, writeSettings }

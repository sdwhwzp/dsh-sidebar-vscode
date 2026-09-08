'use strict'
/** DSH-owned editor settings: browser payload validation and durable-file behavior. */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { ensureSpool, readTheme, seedGitIdentity, writeSettings } = require('../tenant-settings.cjs')

/** A state root whose tenant directory already exists, as the root launcher leaves it. */
function stateRoot(tenant = 'u2') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-vsceditor-'))
  for (const name of new Set([tenant, 'u3'])) mkdirSync(path.join(root, name, 'data'), { recursive: true })
  return root
}

const DARK = { scheme: 'dark', colors: { 'sideBar.background': '#151517' } }

test('a theme payload keeps allowlisted hex colors and drops everything else', () => {
  const accepted = readTheme({
    scheme: 'dark',
    colors: {
      'sideBar.background': '#151517',
      'tab.activeBorderTop': '#4176E6CC',
      'editor.background': '#000000',
      'sideBar.foreground': 'rgb(1,2,3)',
      'sideBar.border': 12,
    },
  })
  assert.deepEqual(accepted, { scheme: 'dark', colors: { 'sideBar.background': '#151517' } })
  assert.equal(readTheme({ scheme: 'sepia', colors: {} }), undefined)
  assert.equal(readTheme(null), undefined)
  assert.equal(readTheme({ scheme: 'light' }).scheme, 'light')
})

test('writing replaces the DSH keys, keeps the account own keys, and hides configured chrome', async () => {
  const root = stateRoot()
  const file = path.join(root, 'u2', 'data', 'user', 'User', 'settings.json')
  await writeSettings(root, 'u2', DARK, ['menuBar', 'statusBar'])
  let written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written['workbench.colorTheme'], 'Default Dark Modern')
  assert.deepEqual(written['workbench.colorCustomizations'], DARK.colors)
  assert.equal(written['window.menuBarVisibility'], 'hidden')
  assert.equal(written['workbench.statusBar.visible'], false)
  assert.equal('workbench.activityBar.location' in written, false)

  writeFileSync(file, JSON.stringify({ ...written, 'editor.fontSize': 15 }))
  await writeSettings(root, 'u2', readTheme({ scheme: 'light', colors: {} }), [])
  written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written['editor.fontSize'], 15, 'account settings survive')
  assert.equal(written['workbench.colorTheme'], 'Default Light Modern')
  assert.equal('workbench.colorCustomizations' in written, false)
  assert.equal('window.menuBarVisibility' in written, false)
})

test('a settings file that is not JSON is reported and left byte-identical', async () => {
  const root = stateRoot()
  const directory = path.join(root, 'u2', 'data', 'user', 'User')
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'settings.json')
  writeFileSync(file, '{ "editor.fontSize": 15, // hand edited\n}')
  const before = readFileSync(file)
  await assert.rejects(writeSettings(root, 'u2', DARK, []), SyntaxError)
  assert.deepEqual(readFileSync(file), before)
})

test('writing waits for the tenant directory the root launcher owns', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-vsceditor-'))
  await assert.rejects(writeSettings(root, 'u2', DARK, []), error => error.code === 'ENOENT')
})

test('the git identity is seeded once and never rewritten', async () => {
  const root = stateRoot()
  const file = await seedGitIdentity(root, 'u2', 'alice', 'dsh.local')
  assert.match(readFileSync(file, 'utf8'), /name = alice\n\temail = alice@dsh\.local/)
  writeFileSync(file, '[user]\n\tname = chosen\n')
  await seedGitIdentity(root, 'u2', 'alice', 'dsh.local')
  assert.equal(readFileSync(file, 'utf8'), '[user]\n\tname = chosen\n')
})

test('the companion command spool is created inside the account own state', async () => {
  const root = stateRoot()
  const first = await ensureSpool(root, 'u2')
  assert.equal(first, path.join(root, 'u2', 'data', 'dsh-sidebar-vscode'))
  writeFileSync(path.join(first, 'kept'), 'x')
  assert.equal(await ensureSpool(root, 'u2'), first, 'creation is idempotent')
  assert.equal(readFileSync(path.join(first, 'kept'), 'utf8'), 'x', 'an existing spool is left alone')
  assert.notEqual(await ensureSpool(root, 'u3'), first, 'each account gets its own')
})

/** Account authorization for the complete official-sidebar command-channel method table. */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { slugOf } from '../src/openChannel.ts'

const runtime = vi.hoisted(() => ({
  access: { authorize: vi.fn() },
  host: { Config: (value: unknown) => value, apply: vi.fn() },
}))
vi.mock('../src/tenant.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tenant.ts')>()
  return { ...actual, loadEditorRuntime: () => runtime }
})
import { apply } from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
const roots: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tenant-routes-')); roots.push(root)
  let handler: Handler | undefined
  const context = {
    on: () => () => {},
    effect: (fn: () => unknown) => fn(),
    inject: (names: string[], fn: (ctx: unknown) => unknown) => { if (names.includes('principalAccess')) fn({}) },
    get: () => undefined,
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
  }
  apply(context as unknown as Context, { tenant: { stateRoot: root } })
  const call = async (method: string, sessionId: string | null) => {
    const req = Object.assign(Readable.from([JSON.stringify({ folder: '/foreign', nonce: 'boot-a', sessionId })]), {
      method: 'POST', url: '/sidebar-vscode/api/' + method, headers: { host: 'localhost' },
    })
    let status = 0; let answer = ''
    const res = { writeHead: (code: number) => { status = code }, end: (body: string) => { answer = body } }
    await handler!(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    return { status, answer: JSON.parse(answer) }
  }
  return { root, call }
}

describe('tenant channel dispatch', () => {
  it.each(['open.capability', 'open.embedded', 'open.request', 'boot.begin', 'boot.status', 'boot.interact', 'ref.take'])('refuses another account before %s touches its spool', async method => {
    const { call } = await fixture()
    runtime.access.authorize.mockRejectedValue(new Error('Session access denied'))
    expect((await call(method, 'foreign-session')).status).toBe(403)
    expect(runtime.access.authorize).toHaveBeenCalledWith({}, expect.anything(), 'foreign-session')
  })

  it('stores the new interaction marker only in the authorized account folder', async () => {
    const { root, call } = await fixture()
    runtime.access.authorize.mockResolvedValue({ owner: '2', tenant: 'u2', folder: '/workspace/app' })
    expect((await call('boot.interact', 'own-session')).status).toBe(200)
    const marker = join(root, 'u2/data/dsh-sidebar-vscode', slugOf('/workspace/app'), 'interact.json')
    expect(JSON.parse(await readFile(marker, 'utf8')).nonce).toBe('boot-a')
    await expect(readFile(join(root, 'u2/data/dsh-sidebar-vscode', slugOf('/foreign'), 'interact.json'))).rejects.toThrow()
  })
})

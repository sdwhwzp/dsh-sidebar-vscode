const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { authorize, proxyHeaders } = require('../tenant-access.cjs')
const { Config } = require('../tenant-host.cjs')

test('persisted session owner and canonical managed root determine the editor target', async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'editor-access-')))
  try {
    const root = path.join(temp, 'u2'), other = path.join(temp, 'u3')
    await fs.mkdir(path.join(root, '测试'), { recursive: true }); await fs.mkdir(other)
    await fs.symlink(other, path.join(root, 'escape'))
    let principal = { source: 'dsh-passwords', id: '2', role: 'user' }
    let cwd = path.join(root, '测试'), allowed = true, managed = root
    const ctx = {
      connection: { authorizeRequest: async () => ({ accepted: !!principal, principal }) },
      principalAccess: { resolve: async () => ({ readableSessionIds: new Set(allowed ? ['session-one'] : []) }) },
      managedUserWorkspace: { resolve: async () => managed },
      sessionQuery: { listSessions: async () => [{ header: { id: 'session-one', cwd } }] },
    }
    assert.equal((await authorize(ctx, {}, 'session-one')).folder, '/workspace/测试')
    allowed = false; await assert.rejects(authorize(ctx, {}, 'session-one'), /access denied/); allowed = true
    cwd = other; await assert.rejects(authorize(ctx, {}, 'session-one'), /outside/)
    cwd = path.join(root, 'escape'); await assert.rejects(authorize(ctx, {}, 'session-one'), /outside/)
    cwd = root; managed = path.join(root, 'escape'); await assert.rejects(authorize(ctx, {}, 'session-one'), /Managed/)
    managed = root; principal = undefined; await assert.rejects(authorize(ctx, {}, 'session-one'), /Authentication/)
    await assert.rejects(authorize(ctx, {}, '../session-one'), /Invalid session/)
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
test('editor transport never receives credentials or attacker-supplied forwarded headers', () => {
  const headers = proxyHeaders({ headers: { cookie: 'secret', authorization: 'secret', 'x-dsh-principal': 'secret', 'x-dsh-principal-signature': 'secret', 'x-forwarded-host': 'evil', host: 'evil', origin: 'https://evil', 'sec-websocket-key': 'key', upgrade: 'websocket', connection: 'upgrade', 'content-type': 'text/plain' } }, true)
  assert.deepEqual(headers, { host: 'localhost', origin: 'http://localhost', 'content-type': 'text/plain', connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-key': 'key' })
})
test('invalid deployment configuration fails before launching a process', () => {
  for (const value of [{ launcher: 'relative' }, { stateRoot: null }, { maxInstances: 0 }, { idleTimeoutMs: -1 }, { startTimeoutMs: 1.1 }]) assert.throws(() => Config(value))
  assert.equal(Config({ maxInstances: 2 }).maxInstances, 2)
})

test('Cordis Standard Schema validates plugin configuration', () => {
  assert.equal(Config['~standard'].validate({ maxInstances: 2 }).value.maxInstances, 2)
  assert(Config['~standard'].validate({ maxInstances: 0 }).issues.length > 0)
})

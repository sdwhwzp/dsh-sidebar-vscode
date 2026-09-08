'use strict'
/** Tenant code-server instances reached only through authenticated DSH routes. */
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { lstat } = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')
const { PREFIX, SID, authorize, proxyHeaders } = require('./tenant-access.cjs')
const { CHROME, ensureSpool, readTheme, seedGitIdentity, writeSettings } = require('./tenant-settings.cjs')

function Config(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Editor configuration must be an object')
  const config = { launcher: '/usr/local/libexec/dsh-tenant-editor', stateRoot: '/var/lib/dsh-vsceditor', codeServerCommit: 'd2f7a122522456b351e9b3ddd39e4f3fb9fd5318', startTimeoutMs: 30000, maxInstances: 4, idleTimeoutMs: 900000, followTheme: true, hiddenChrome: ['menuBar', 'activityBar', 'statusBar', 'chat'], gitIdentity: true, gitEmailDomain: 'dsh.local', spool: true, ...value }
  if (!/^[a-f0-9]{40}$/.test(config.codeServerCommit)) throw new Error('Invalid code-server commit')
  for (const key of ['launcher', 'stateRoot']) if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(key + ' must be absolute')
  for (const key of ['startTimeoutMs', 'maxInstances', 'idleTimeoutMs']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(key + ' must be positive')
  if (typeof config.followTheme !== 'boolean') throw new Error('followTheme must be a boolean')
  if (typeof config.gitIdentity !== 'boolean') throw new Error('gitIdentity must be a boolean')
  if (typeof config.spool !== 'boolean') throw new Error('spool must be a boolean')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(config.gitEmailDomain)) throw new Error('gitEmailDomain must be a domain name')
  if (!Array.isArray(config.hiddenChrome) || config.hiddenChrome.some(part => !Object.hasOwn(CHROME, part))) throw new Error('hiddenChrome must list only ' + Object.keys(CHROME).join(', '))
  return config
}

// Cordis consumes Standard Schema v1; retain the callable resolver for direct use.
Config['~standard'] = {
  version: 1, vendor: 'dsh-sidebar-vscode',
  validate(value) {
    try { return { value: Config(value) } }
    catch (error) { return { issues: [{ message: error.message }] } }
  },
}

function apply(ctx, input) {
  const config = Config(input)
  if (process.platform !== 'linux') throw new Error('Tenant editor requires Linux')
  const instances = new Map()
  const upgrades = new Map()
  let disposed = false
  function stop(key) {
    const item = instances.get(key)
    if (!item) return
    instances.delete(key)
    for (const socket of item.sockets) socket.destroy()
    item.child.kill('SIGTERM')
    for (const [sid, route] of upgrades) if (route.owner === key) { route.dispose(); upgrades.delete(sid) }
  }
  async function start(target) {
    if (disposed) throw new Error('Editor is stopping')
    let item = instances.get(target.owner)
    if (item && item.root !== target.root) { stop(target.owner); item = undefined }
    if (item) { item.used = Date.now(); await item.ready; return item }
    if (instances.size >= config.maxInstances) throw new Error('Editor capacity reached; try later')
    const info = await lstat(config.launcher)
    if (info.uid !== 0 || (info.mode & 0o022) || !info.isFile()) throw new Error('Editor launcher must be root-owned')
    // Recheck after the asynchronous filesystem read to serialize simultaneous starts.
    if (instances.has(target.owner)) return start(target)
    if (disposed || instances.size >= config.maxInstances) throw new Error('Editor capacity reached')
    const child = spawn('/usr/bin/sudo', ['-n', '--', config.launcher, target.owner, target.tenant], { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
    item = { child, root: target.root, socketPath: path.join(config.stateRoot, target.tenant, 'run', 'editor.sock'), used: Date.now(), sockets: new Set(), error: '', ready: null }
    instances.set(target.owner, item)
    child.stdout.on('data', () => {})
    child.stderr.on('data', data => { item.error = (item.error + data.toString()).slice(-4096) })
    let failed = false
    child.on('error', () => { failed = true })
    child.on('exit', () => { failed = true; if (instances.get(target.owner) === item) stop(target.owner) })
    item.ready = (async () => {
      const deadline = Date.now() + config.startTimeoutMs
      while (Date.now() < deadline && !failed && !disposed) {
        const ready = await new Promise(resolve => {
          const request = http.get({ socketPath: item.socketPath, path: '/healthz', timeout: 700 }, res => { res.resume(); resolve(res.statusCode === 200) })
          request.on('error', () => resolve(false)); request.on('timeout', () => { request.destroy(); resolve(false) })
        })
        if (ready) return
        await delay(200)
      }
      stop(target.owner)
      throw new Error('Editor failed to start; contact the administrator')
    })()
    await item.ready
    return item
  }
  function registerUpgrade(target) {
    if (upgrades.has(target.sessionId)) return
    const base = PREFIX + '/ide/' + target.sessionId + '/'
    const handler = async (req, socket, head) => {
      try {
        const checked = await authorize(ctx, req, target.sessionId)
        const item = instances.get(checked.owner)
        if (!item || item.root !== checked.root) throw new Error('Editor unavailable')
        item.used = Date.now()
        const upstream = net.connect(item.socketPath)
        item.sockets.add(socket)
        upstream.once('connect', () => {
          const url = new URL(req.url, 'http://localhost')
          const headers = proxyHeaders(req, true)
          upstream.write('GET /' + url.pathname.slice(base.length) + url.search + ' HTTP/1.1\r\n' + Object.entries(headers).map(([key, val]) => key + ': ' + val).join('\r\n') + '\r\n\r\n')
          if (head.length) upstream.write(head)
          socket.pipe(upstream); upstream.pipe(socket)
        })
        socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
        socket.on('close', () => { item.sockets.delete(socket); item.used = Date.now(); upstream.destroy() })
        upstream.on('close', () => socket.destroy())
      } catch { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') }
    }
    const dispose = ctx.effect(() => {
      const disposers = [base, base + 'stable-' + config.codeServerCommit].map(path => ctx.webServer.registerUpgrade({ path, handler }))
      return () => { for (const release of disposers) release() }
    }, 'dsh-sidebar-vscode editor: session socket')
    upgrades.set(target.sessionId, { owner: target.owner, dispose })
  }
  function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  /** Read a size-capped JSON request body; an empty body carries no theme. */
  async function body(req) {
    const chunks = [];let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 16384) throw new Error('Theme payload too large')
      chunks.push(chunk)
    }
    return size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  /** Rewrite the account's DSH-owned editor settings; VS Code applies them to a running editor. */
  async function settings(target, theme) {
    await writeSettings(config.stateRoot, target.tenant, config.followTheme ? theme : undefined, config.hiddenChrome)
    if (config.gitIdentity) await seedGitIdentity(config.stateRoot, target.tenant, target.account, config.gitEmailDomain)
    if (config.spool) await ensureSpool(config.stateRoot, target.tenant)
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === PREFIX + '/open') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' })
        const target = await authorize(ctx, req, url.searchParams.get('sessionId'))
        await start(target); registerUpgrade(target)
        // Written after the launcher owns the tenant state directory, and never
        // fatal: a settings failure must not keep the account out of its editor.
        const applied = await body(req).then(value => settings(target, readTheme(value))).then(() => true, () => false)
        return json(res, 200, { url: PREFIX + '/ide/' + target.sessionId + '/?folder=' + encodeURIComponent(target.folder), folder: target.folder, settings: applied })
      }
      if (url.pathname === PREFIX + '/theme') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' })
        const target = await authorize(ctx, req, url.searchParams.get('sessionId'))
        const theme = readTheme(await body(req))
        if (theme === undefined) return json(res, 400, { error: 'Theme payload requires a dark or light scheme' })
        await settings(target, theme)
        return json(res, 200, { settings: true })
      }
      const match = url.pathname.match(/^\/dsh-vsceditor\/ide\/(session-[a-zA-Z0-9-]{1,100})\/(.*)$/)
      if (!match || !SID.test(match[1])) return json(res, 404, { error: 'Not found' })
      const target = await authorize(ctx, req, match[1])
      const item = instances.get(target.owner)
      if (!item || item.root !== target.root) return json(res, 409, { error: 'Reopen the editor from the session tab' })
      item.used = Date.now()
      const request = http.request({ socketPath: item.socketPath, method: req.method, path: '/' + match[2] + url.search, headers: proxyHeaders(req) }, response => {
        const headers = { ...response.headers, 'cache-control': 'private, no-store', 'x-frame-options': 'SAMEORIGIN' }
        delete headers['set-cookie']
        if (headers.location?.startsWith('/')) headers.location = PREFIX + '/ide/' + target.sessionId + headers.location
        res.writeHead(response.statusCode || 502, headers); response.pipe(res)
      })
      request.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Editor unavailable' }); else res.destroy() })
      res.on('close', () => request.destroy()); req.pipe(request)
    } catch (error) { if (!res.headersSent) json(res, 403, { error: error.message }); else res.destroy() }
  } }), 'dsh-sidebar-vscode editor: authenticated routes')
  ctx.effect(() => {
    const timer = setInterval(() => { for (const [key, item] of instances) if (!item.sockets.size && Date.now() - item.used > config.idleTimeoutMs) stop(key) }, Math.min(config.idleTimeoutMs, 30000))
    timer.unref()
    return () => { disposed = true; clearInterval(timer); for (const key of instances.keys()) stop(key) }
  }, 'dsh-sidebar-vscode editor: instance cleanup')
}
module.exports = { name: 'dsh-sidebar-vscode-editor', inject: ['webServer', 'connection', 'principalAccess', 'managedUserWorkspace', 'sessionQuery'], Config, apply }

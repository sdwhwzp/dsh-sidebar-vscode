'use strict'
/**
 * Authorization for tenant editor routes: the single place that turns an
 * authenticated principal plus a session id into the tenant whose workspace may
 * be reached. The single copy of these checks: the routes
 * serving the workbench and the routes serving the extension command channel
 * must not drift apart on who may read which session.
 */
const path = require('node:path')
const { realpath } = require('node:fs/promises')
const PREFIX = '/sidebar-vscode/editor'
const SID = /^session-[a-zA-Z0-9-]{1,100}$/

/** Select a persisted session inside the authenticated account's managed root. */
async function authorize(ctx, req, sessionId) {
  if (!SID.test(sessionId || '')) throw new Error('Invalid session')
  const auth = await ctx.connection.authorizeRequest(req)
  const principal = auth.principal
  if (!auth.accepted || principal?.source !== 'dsh-passwords' || !/^[1-9][0-9]{0,15}$/.test(principal.id)) throw new Error('Authentication required')
  const access = await ctx.principalAccess.resolve(principal, { sessionIds: [sessionId] })
  if (!access.readableSessionIds.has(sessionId)) throw new Error('Session access denied')
  const root = await ctx.managedUserWorkspace.resolve(principal)
  if (!root || await realpath(root) !== root) throw new Error('Managed workspace required')
  const record = (await ctx.sessionQuery.listSessions()).find(item => item.header.id === sessionId)
  if (!record?.header.cwd) throw new Error('Session directory unavailable')
  const cwd = await realpath(record.header.cwd)
  const relative = path.relative(root, cwd)
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Session is outside your managed workspace')
  const tenant = path.basename(root)
  const pattern = new RegExp('^(?:u' + principal.id + '(?:-[a-f0-9]{12})?|admin-u' + principal.id + ')$')
  if (!pattern.test(tenant)) throw new Error('Invalid managed workspace')
  // The gateway's display name reaches a config file, so anything outside the
  // safe set falls back to the account id rather than being escaped.
  const account = /^[A-Za-z0-9._-]{1,64}$/.test(principal.username ?? '') ? principal.username : 'u' + principal.id
  return { owner: principal.id, account, root, tenant, folder: path.posix.join('/workspace', relative), sessionId }
}

/** Forward only browser transport headers; never relay Host or gateway credentials. */
function proxyHeaders(req, upgrade = false) {
  const headers = { host: 'localhost', origin: 'http://localhost' }
  const allowed = ['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'user-agent']
  if (upgrade) allowed.push('connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions')
  for (const key of allowed) if (req.headers[key] !== undefined) headers[key] = req.headers[key]
  return headers
}
module.exports = { PREFIX, SID, authorize, proxyHeaders }

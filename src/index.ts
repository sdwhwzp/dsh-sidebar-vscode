/**
 * `dsh-sidebar-vscode`, node half: the vscode-selection context boundary
 * plus the extension command channel's two fenced routes.
 *
 * Everything UI-shaped (the better-sidebar VS Code tab, the composer
 * chips, the reference rail, the chat-open interception) lives in the
 * browser half. This half owns:
 *
 * - the model-facing seam: for every live agent it listens at
 *   `agent/pre-step`, expands canonical `dsh-vscode:` (editor selections)
 *   and `dsh-vscode-res:` (explorer file/folder) mentions in the claimed
 *   user messages into readable labels plus bounded `<text-selection>`
 *   context messages sourced `{ kind: 'vscode-mention', … }` — or, for
 *   resources, content-less `<file-selection>`/`<folder-selection>`
 *   markers sourced `{ kind: 'vscode-resource', … }` (see `src/mention.ts`);
 *
 * - `/sidebar-vscode/api/open.capability` + `/open.request`: the spool the
 *   embedded workbench's extension polls (see `src/openChannel.ts`), fenced
 *   by the same browser-trust rules as every other plugin route; the
 *   `boot.begin` / `boot.status` pair rides the same fence to gate the
 *   iframe reveal on the extension's post-reconcile boot receipt;
 *
 * - `/sidebar-vscode/api/settings.document`: locates the settings provider's
 *   local document (prepareDocument) for the browser-half takeover of the
 *   settings page's「打开配置文件」button — the stock /api method opens it
 *   with the Host OS opener (dead on headless containers) and never reveals
 *   the path; this route hands the path to this plugin's own fenced channel
 *   so the file can open inside the embedded VS Code instead.
 *
 * - the same-origin VS Code reverse proxy (see `src/vscodeProxy.ts`),
 *   mounted at `/sidebar/vscode`: an HTTP prefix route plus the discovered
 *   WebSocket upgrade path, so gateway-less deployments (Windows, LAN)
 *   still get a same-origin workbench iframe. `/sidebar-vscode/api/
 *   proxy.config` lets the browser half push the `serverUrl` setting (a
 *   full serve-web URL, base path + token) as the proxy's upstream, with a
 *   bounded reachability probe in the answer; `proxy.status` reports the
 *   live mounting state for the iframe-base choice.
 *
 * @module dsh-sidebar-vscode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only: brings the agent event and PreStepDecision declarations in.
import type {} from '@deepseek-ai/dsh-agent'
import { createFileRangeReader, vscodeMentionPreStep } from './mention.ts'
import {
  OPEN_CHANNEL_BASE,
  takeReferences,
  parseOpenCommand,
  readBootStatus,
  readCapabilityMarker,
  writeBootRequest,
  writeEmbeddedBoot,
  writeOpenCommand,
} from './openChannel.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { loadEditorRuntime, readTenantOptions, resolveTenantSpool, type TenantOptions } from './tenant.ts'
import { createVscodeProxy, parseUpstreamUrl, type ProxyPluginContext, PROXY_MOUNT } from './vscodeProxy.ts'

/** Cordis plugin name (the Loader entry; matches the client bundle id). */
export const name = 'dsh-sidebar-vscode'

/** Services required before load: the agent registry (agent/created
 * events), the webserver (command-channel routes), and the web runtime
 * (the trust fence's live trustedHosts). */
export const inject = ['agents', 'webServer', 'webRuntime']

/**
 * Services `tenant` mode authorizes through. They are acquired by a nested
 * inject rather than named here: a single-account composition has no passwords
 * gateway, and listing them at the top level would leave the whole plugin
 * pending forever instead of running its upstream behavior.
 */
const TENANT_SERVICES = ['connection', 'principalAccess', 'managedUserWorkspace', 'sessionQuery']

/** Open-channel methods addressed by a spool directory, and so by an account. */
const SPOOL_METHODS = new Set(['open.capability', 'open.embedded', 'open.request', 'boot.begin', 'boot.status', 'ref.take'])

/** Validated plugin configuration. */
export interface PluginConfig {
  /**
   * Per-account editor mode. Present: every open-channel request is authorized
   * and answered from that account's own spool, and the built-in reverse proxy
   * stays off because it serves one shared upstream with no authorization of
   * its own. Absent: the upstream single-account behavior.
   */
  readonly tenant?: TenantOptions
}

/**
 * Validate the loader entry's config.
 * @param value - raw config value.
 * @returns the accepted configuration.
 * @throws {Error} when a field is present but malformed.
 */
export function Config(value: unknown = {}): PluginConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-sidebar-vscode configuration must be an object')
  }
  const tenant = readTenantOptions((value as { tenant?: unknown }).tenant)
  return tenant === undefined ? {} : { tenant }
}

// Cordis consumes Standard Schema v1; the callable resolver stays for direct use.
Config['~standard'] = {
  version: 1 as const,
  vendor: 'dsh-sidebar-vscode',
  validate(value: unknown) {
    try { return { value: Config(value) } }
    catch (error) { return { issues: [{ message: error instanceof Error ? error.message : String(error) }] } }
  },
}

/** One JSON answer over the response stream. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Read one request body as JSON, capped (the payloads are tiny). */
async function readJsonBody(req: IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > limit) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The route face the node half touches (structural over the services). */
interface HostContextFace {
  webServer: {
    register(route: {
      kind: 'prefix' | 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
    }): () => void
  }
  webRuntime: { trustedHosts: readonly string[] }
  /** The settings provider face this plugin reads (prepareDocument only). */
  get(name: 'settings'): { prepareDocument(): Promise<string | undefined> } | undefined
}

/**
 * Mount the vscode-selection pre-step boundary for every agent.
 * @param ctx - host cordis context.
 */
export function apply(ctx: Context, input: unknown = {}): void {
  const config = Config(input)
  const tenant = config.tenant
  const runtime = tenant === undefined ? undefined : loadEditorRuntime()
  const tenantAccess = runtime?.access
  // The context spool calls authorize against: live only while the gateway's
  // services are, so a request arriving before they compose is refused rather
  // than served unauthorized.
  let authorizing: unknown
  if (tenant !== undefined && runtime !== undefined) {
    ctx.inject([...TENANT_SERVICES, 'webServer'], (scoped: unknown) => {
      authorizing = scoped
      // The per-account workbench: instances, their sandbox launcher, and the
      // authorized proxy in front of them. Mounted on the same fiber as the
      // authorization services, so it withdraws with them.
      runtime.host.apply(scoped, tenant)
      return () => { authorizing = undefined }
    })
  }
  const readFileRange = createFileRangeReader()
  // The listener lives on the agent's scope (the event is agent-scoped), so it
  // registers per created agent and withdraws with it.
  /* v8 ignore start -- agent-scoped registration glue; the boundary behavior is vscodeMentionPreStep (unit-tested) and the event plumbing is harness-owned. */
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => {
      const stop = agent.ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
        return vscodeMentionPreStep(
          agent.session.header.cwd,
          readFileRange,
          messages,
          signal,
          next,
        )
      })
      return () => { stop() }
    }, 'dsh-sidebar-vscode: vscode-mention contexts')
  })
  /* v8 ignore stop */

  // ── Same-origin /vscode reverse proxy ──────────────────────────────────
  // Probe-gated and fail-soft: an unreachable or conflicting upstream only
  // logs, never failing plugin activation (see vscodeProxy.ts). The
  // `proxy.config` route below lets the browser half push the `serverUrl`
  // setting (a full `code serve-web` URL, base path + token included) as
  // the proxy's upstream.
  // The built-in proxy serves ONE upstream and authorizes nothing, so a
  // per-account deployment must not mount it: the workbench is reached through
  // this plugin's own authorized per-session route instead.
  const proxy = tenant === undefined ? createVscodeProxy(ctx as unknown as ProxyPluginContext) : undefined

  // ── Extension command channel routes ───────────────────────────────────
  // POST /sidebar-vscode/api/open.capability {folder} → {ok, value:{present}}
  // POST /sidebar-vscode/api/open.request   {folder, path, nonce, …} → {ok}
  // POST /sidebar-vscode/api/settings.document (no body) → {ok, value:{path}}
  // Fenced like every other plugin route (browser-trust fence over the
  // live trustedHosts); a cross-site page cannot reach them.
  const host = ctx as unknown as HostContextFace
  ctx.effect(() => host.webServer.register({
    kind: 'prefix',
    path: '/sidebar-vscode/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, host.webRuntime.trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidebar-vscode/api/')
        ? pathname.slice('/sidebar-vscode/api/'.length)
        : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        return
      }
      // The settings-document locator: the settings button takeover needs the
      // Host-side absolute path the stock /api method deliberately withholds
      // from the browser. No body is read (nothing to validate), and the
      // answer only rides the same fenced same-origin route family as the
      // open channel — the path names a document whose existence the settings
      // provider itself guarantees (prepareDocument materializes it).
      if (method === 'settings.document') {
        const settings = host.get('settings')
        if (settings === undefined) {
          writeJson(res, 500, { ok: false, error: { code: 'settings-absent', message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition' } })
          return
        }
        let path: string | undefined
        try {
          path = await settings.prepareDocument()
        } catch (error) {
          writeJson(res, 500, { ok: false, error: { code: 'internal', message: `settings document preparation failed: ${error instanceof Error ? error.message : String(error)}` } })
          return
        }
        if (path === undefined || path === '') {
          writeJson(res, 500, { ok: false, error: { code: 'no-document', message: 'settings provider has no local document to open' } })
          return
        }
        writeJson(res, 200, { ok: true, value: { path } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        // Per-account mode addresses the spool by the AUTHENTICATED account:
        // every tenant sees its own workspace at the same sandbox path, so the
        // folder the browser names identifies nothing and is not trusted here.
        let spool = OPEN_CHANNEL_BASE
        let owned: string | undefined
        if (tenant !== undefined && tenantAccess !== undefined && SPOOL_METHODS.has(method)) {
          const claimed = (payload as { sessionId?: unknown } | null)?.sessionId
          try {
            if (authorizing === undefined) throw new Error('the authorization services are not composed')
            const resolved = await resolveTenantSpool(tenantAccess, authorizing, tenant, req, typeof claimed === 'string' ? claimed : null)
            spool = resolved.base
            owned = resolved.folder
          } catch (error) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: error instanceof Error ? error.message : 'forbidden' } })
            return
          }
        }
        // The built-in proxy is absent in per-account mode; both of its
        // methods answer "not serving" so the browser half opens at the
        // account's authorized route instead of waiting for a mount.
        if ((method === 'proxy.status' || method === 'proxy.config') && proxy === undefined) {
          writeJson(res, 200, { ok: true, value: { mounted: false, prefix: PROXY_MOUNT, serving: false, tenant: true } })
          return
        }
        if (method === 'proxy.status' && proxy !== undefined) {
          // No fields required: the browser half asks whether the built-in
          // proxy is serving, so an UNSET serverUrl can open the workbench
          // at the mount instead of the gateway-subpath default.
          const { mounted, prefix, serving } = proxy.status()
          writeJson(res, 200, { ok: true, value: { mounted, prefix, serving } })
          return
        }
        if (method === 'proxy.config' && proxy !== undefined) {
          const record = payload as { url?: unknown, reset?: unknown } | null
          if (record !== null && record.reset === true) {
            proxy.configure(null)
            writeJson(res, 200, { ok: true, value: { mounted: null } })
            return
          }
          if (record === null || typeof record.url !== 'string' || record.url.trim() === '') {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'url must be a non-empty string (or {"reset":true})' } })
            return
          }
          const config = parseUpstreamUrl(record.url)
          if (config === null) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-upstream', message: 'url must be an http(s) URL without embedded credentials — the full address code serve-web prints, base path and query included' } })
            return
          }
          // Bounded liveness probe BEFORE adopting: the browser half falls
          // back to the direct cross-origin iframe when the DSH host
          // cannot reach the pasted address (e.g. a remote serve-web).
          // The fetched page doubles as the discovery seed, so the adopt
          // below does not refetch it.
          const fetched = await proxy.probeUpstream(config)
          proxy.configure(config, fetched ?? undefined)
          writeJson(res, 200, { ok: true, value: { mounted: `${PROXY_MOUNT}/`, reachable: fetched !== null } })
          return
        }
        if (method === 'open.capability') {
          const record = payload as { folder?: unknown } | null
          if (record === null || typeof record.folder !== 'string' || record.folder === '') {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder must be a non-empty string' } })
            return
          }
          const marker = await readCapabilityMarker(spool, owned ?? record.folder)
          writeJson(res, 200, { ok: true, value: { present: marker.present, version: marker.version } })
          return
        }
        if (method === 'open.embedded') {
          // The sidebar's workbench iframe just loaded for this folder:
          // stamp the embedded-boot marker the extension reads at
          // activation (a fresh stamp = an EMBEDDED boot, which starts
          // with a clean editor area — see writeEmbeddedBoot).
          const record = payload as { folder?: unknown } | null
          if (record === null || typeof record.folder !== 'string' || !record.folder.startsWith('/')) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder must be an absolute path' } })
            return
          }
          await writeEmbeddedBoot(spool, owned ?? record.folder)
          writeJson(res, 200, { ok: true })
          return
        }
        if (method === 'open.request') {
          const command = parseOpenCommand(payload)
          if (command === null) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'malformed open request' } })
            return
          }
          await writeOpenCommand(spool, owned === undefined ? command : { ...command, folder: owned })
          writeJson(res, 200, { ok: true })
          return
        }
        if (method === 'boot.begin') {
          // The sidebar's client parks one boot nonce BEFORE mounting the
          // workbench iframe; the extension (≥ 0.1.2) echoes it in its
          // post-reconcile boot.json receipt, and boot.status reports the
          // match — the client keeps the iframe hidden (opacity 0) until
          // then, so a reconciled editor area is the FIRST thing the user
          // sees: restored-but-closed ghost files never visibly open.
          const record = payload as { folder?: unknown, nonce?: unknown } | null
          if (record === null || typeof record.folder !== 'string' || !record.folder.startsWith('/')) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder must be an absolute path' } })
            return
          }
          if (typeof record.nonce !== 'string' || record.nonce === '' || record.nonce.length > 128) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'nonce must be a non-empty string of at most 128 characters' } })
            return
          }
          await writeBootRequest(spool, owned ?? record.folder, record.nonce)
          writeJson(res, 200, { ok: true })
          return
        }
        if (method === 'ref.take') {
          const record = payload as { folder?: unknown } | null
          const folder = owned ?? (record !== null && typeof record.folder === 'string' ? record.folder : undefined)
          if (folder === undefined || !folder.startsWith('/')) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder must be an absolute path' } })
            return
          }
          writeJson(res, 200, { ok: true, value: { envelopes: await takeReferences(spool, folder) } })
          return
        }
        if (method === 'boot.status') {
          const record = payload as { folder?: unknown, nonce?: unknown } | null
          if (record === null || typeof record.folder !== 'string' || !record.folder.startsWith('/')) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'folder must be an absolute path' } })
            return
          }
          if (typeof record.nonce !== 'string' || record.nonce === '' || record.nonce.length > 128) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'nonce must be a non-empty string of at most 128 characters' } })
            return
          }
          const matched = await readBootStatus(spool, owned ?? record.folder, record.nonce)
          writeJson(res, 200, { ok: true, value: { matched } })
          return
        }
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }), 'dsh-sidebar-vscode: /sidebar-vscode/api routes')
}

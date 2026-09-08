/**
 * Multi-account mode: the open-channel spool and the embedded workbench are
 * addressed per authenticated account instead of per workspace folder.
 *
 * The upstream plugin serves one shared `code serve-web` through its own
 * reverse proxy and derives the spool directory from the workspace folder
 * alone. Two accounts whose sessions sit at the same sandbox path (every
 * tenant sees its workspace as `/workspace`) would share one spool, so in a
 * deployment with per-account editors the folder is not an identity. This
 * module resolves the account first — through the editor runtime's
 * authorization, the single copy of those checks — and hands back that
 * account's private spool root.
 *
 * @module dsh-sidebar-vscode/tenant
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

/** The authorization result this module consumes (the runtime is CommonJS, untyped). */
interface TenantTarget {
  /** Account id of the authenticated principal. */
  readonly owner: string
  /** Tenant directory name under the managed workspace root. */
  readonly tenant: string
  /** The session's folder as the sandbox sees it. */
  readonly folder: string
}

/** The slice of the runtime's authorization module this module calls. */
interface TenantAccess {
  authorize(ctx: unknown, req: IncomingMessage, sessionId: string | null): Promise<TenantTarget>
}

/** Per-account editor mode; absent leaves the upstream single-upstream behavior. */
export interface TenantOptions {
  /** Editor state root; each account's workbench state lives under it. */
  readonly stateRoot: string
}

/** Spool root inside one account's editor state, visible to the sandbox as `/editor-data/…`. */
export const TENANT_SPOOL_DIRECTORY = 'dsh-sidebar-vscode'

/**
 * Validate the plugin's `tenant` configuration.
 * @param value - raw config value from the loader entry.
 * @returns the accepted options, or undefined when the deployment is single-account.
 * @throws {Error} when the value is present but not an absolute state root.
 */
export function readTenantOptions(value: unknown): TenantOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('tenant must be an object')
  // The runtime owns this shape; validating it twice would let the two drift.
  return loadEditorRuntime().host.Config(value) as TenantOptions
}

/**
 * Resolve the spool root and folder for one open-channel request.
 * @param access - the published authorization module.
 * @param ctx - host cordis context carrying the connection and workspace services.
 * @param options - validated tenant options.
 * @param req - the incoming request, whose credentials identify the account.
 * @param sessionId - session the browser claims to be working in.
 * @returns the account's spool root and the folder the sandbox sees.
 * @throws {Error} when the principal may not read that session or it sits outside the account's workspace.
 */
export async function resolveTenantSpool(
  access: TenantAccess,
  ctx: unknown,
  options: TenantOptions,
  req: IncomingMessage,
  sessionId: string | null,
): Promise<{ base: string, folder: string, tenant: string }> {
  const target = await access.authorize(ctx, req, sessionId)
  return {
    base: join(options.stateRoot, target.tenant, 'data', TENANT_SPOOL_DIRECTORY),
    folder: target.folder,
    tenant: target.tenant,
  }
}

/** The editor runtime's two entry points this plugin drives. */
export interface EditorRuntime {
  readonly access: TenantAccess
  readonly host: {
    Config(value: unknown): unknown
    apply(ctx: unknown, config: unknown): void
  }
}

/**
 * Load the editor runtime shipped beside this plugin. It stays CommonJS and is
 * loaded rather than rewritten: it is the authorization and sandbox boundary,
 * and a transcription is a defect this package cannot afford.
 * @returns the authorization and host halves.
 */
export function loadEditorRuntime(): EditorRuntime {
  const require_ = createRequire(import.meta.url)
  return {
    access: require_('../runtime/tenant-access.cjs') as TenantAccess,
    host: require_('../runtime/tenant-host.cjs') as EditorRuntime['host'],
  }
}

/**
 * Load the authorization half alone.
 * @returns the module.
 */
export function loadTenantAccess(): TenantAccess | undefined {
  return loadEditorRuntime().access
}

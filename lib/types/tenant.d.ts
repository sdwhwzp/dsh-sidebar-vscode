import type { IncomingMessage } from 'node:http';
/** The authorization result this module consumes (dsh-vsceditor ships no types). */
interface TenantTarget {
    /** Account id of the authenticated principal. */
    readonly owner: string;
    /** Tenant directory name under the managed workspace root. */
    readonly tenant: string;
    /** The session's folder as the sandbox sees it. */
    readonly folder: string;
}
/** The slice of `dsh-vsceditor/tenant-access` this module calls. */
interface TenantAccess {
    authorize(ctx: unknown, req: IncomingMessage, sessionId: string | null): Promise<TenantTarget>;
}
/** Per-account editor mode; absent leaves the upstream single-upstream behavior. */
export interface TenantOptions {
    /** Editor state root, matching the `stateRoot` of the dsh-vsceditor host. */
    readonly stateRoot: string;
}
/** Spool root inside one account's editor state, visible to the sandbox as `/editor-data/…`. */
export declare const TENANT_SPOOL_DIRECTORY = "dsh-sidebar-vscode";
/**
 * Validate the plugin's `tenant` configuration.
 * @param value - raw config value from the loader entry.
 * @returns the accepted options, or undefined when the deployment is single-account.
 * @throws {Error} when the value is present but not an absolute state root.
 */
export declare function readTenantOptions(value: unknown): TenantOptions | undefined;
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
export declare function resolveTenantSpool(access: TenantAccess, ctx: unknown, options: TenantOptions, req: IncomingMessage, sessionId: string | null): Promise<{
    base: string;
    folder: string;
    tenant: string;
}>;
/**
 * Load the published authorization module.
 * @returns the module, or undefined when dsh-vsceditor is not installed beside this plugin.
 */
export declare function loadTenantAccess(): TenantAccess | undefined;
export {};

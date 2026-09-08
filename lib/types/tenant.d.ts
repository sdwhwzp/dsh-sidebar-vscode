import type { IncomingMessage } from 'node:http';
/** The authorization result this module consumes (the runtime is CommonJS, untyped). */
interface TenantTarget {
    /** Account id of the authenticated principal. */
    readonly owner: string;
    /** Tenant directory name under the managed workspace root. */
    readonly tenant: string;
    /** The session's folder as the sandbox sees it. */
    readonly folder: string;
}
/** The slice of the runtime's authorization module this module calls. */
interface TenantAccess {
    authorize(ctx: unknown, req: IncomingMessage, sessionId: string | null): Promise<TenantTarget>;
}
/** Per-account editor mode; absent leaves the upstream single-upstream behavior. */
export interface TenantOptions {
    /** Editor state root; each account's workbench state lives under it. */
    readonly stateRoot: string;
    /** The runtime owns the rest of the shape and fills its own defaults. */
    readonly [key: string]: unknown;
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
/** The editor runtime's two entry points this plugin drives. */
export interface EditorRuntime {
    readonly access: TenantAccess;
    readonly host: {
        Config(value: unknown): unknown;
        apply(ctx: unknown, config: unknown): void;
    };
}
/**
 * Load the editor runtime shipped beside this plugin. It stays CommonJS and is
 * loaded rather than rewritten: it is the authorization and sandbox boundary,
 * and a transcription is a defect this package cannot afford.
 * @returns the authorization and host halves.
 */
export declare function loadEditorRuntime(): EditorRuntime;
/**
 * Load the authorization half alone.
 * @returns the module.
 */
export declare function loadTenantAccess(): TenantAccess | undefined;
export {};

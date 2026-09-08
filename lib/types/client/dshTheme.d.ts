/**
 * The DSH palette as an editor theme payload.
 *
 * The workbench takes its colours from the account's own settings, which the
 * node half writes: the colour scheme selects the base theme so the code pane
 * and syntax colours follow, and these keys carry the DSH tokens into the
 * chrome around it. Sending nothing leaves the editor on the workbench default,
 * which is how it stops following DSH.
 *
 * @module dsh-sidebar-vscode/client/dshTheme
 */
/**
 * Convert one resolved DSH token to the `#rrggbb[aa]` form VS Code settings take.
 *
 * The browser does the parsing. A registered theme writes its token overrides as
 * inline styles in whatever CSS colour form it likes, and a hand-written parser
 * silently drops every form it does not know — which is how the background
 * tokens went missing while the foregrounds came through.
 *
 * @param value - the computed token value, in any CSS colour form.
 * @returns the hex colour, or an empty string when the browser rejects the value.
 */
export declare function hex(value: string): string;
/** One accepted theme payload: the colour scheme plus the chrome colours. */
export interface ThemePayload {
    readonly scheme: 'dark' | 'light';
    readonly colors: Record<string, string>;
}
/**
 * Read the current DSH palette.
 * @param body - the element carrying the theme, the document body by default.
 * @returns the payload the node half validates and writes.
 */
export declare function themePayload(body?: HTMLElement): ThemePayload;

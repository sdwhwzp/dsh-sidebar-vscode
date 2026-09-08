# Fork notes: per-account mode

This fork adds a `tenant` mode for deployments where one DSH serves several
accounts behind `dsh-passwords`. Upstream (`chendefine/dsh-sidebar-vscode`)
targets a single trusted boundary; the two places that assumption shows are
listed below. Everything not described here is upstream behavior, and this file
is the only fork-specific document so upstream merges stay clean.

## Why the mode exists

Upstream serves one shared `code serve-web` through its own reverse proxy, and
that proxy authorizes nothing. Its README states the mount inherits the dsh web
port's exposure: any client that reaches the port reaches the workbench. In a
multi-account deployment that is every account reaching every other account's
files.

The open-channel spool is addressed by `slug(workspace folder)`. Under
per-account sandboxes every tenant sees its own workspace at the same path, so
two accounts collide on one spool directory — a shared read/write channel, not
merely a broken feature.

## What the mode changes

`tenant: { stateRoot }` in the loader entry turns both around:

- The built-in proxy is not mounted. The account's workbench is reached through
  `dsh-vsceditor`'s authorized per-session route, which checks the principal,
  the session's readability and the managed workspace root on every request and
  serves a per-account code-server inside a bwrap sandbox. `proxy.status` and
  `proxy.config` answer "not serving" so the browser half opens there rather
  than waiting for a mount.
- Every spool method authorizes first and answers from
  `<stateRoot>/<tenant>/data/dsh-sidebar-vscode`. The folder it uses is the
  authorized one, never the value the browser named.

Authorization is `dsh-vsceditor/tenant-access`, not a second copy of the same
checks: two plugins serving one editor must not drift on who may read which
session. Tenant mode fails to load when that package is absent.

## Status

The host half is complete and covered by `tests/tenant.spec.ts` (472 tests
total). Not yet done:

1. Browser half: point the tab's iframe at `/dsh-vsceditor/ide/<sessionId>/`
   and carry `sessionId` on every open-channel call.
2. `dsh-vsceditor`'s launcher: set `DSH_SIDEBAR_VSCODE_SPOOL` to
   `/editor-data/dsh-sidebar-vscode`, the sandbox's view of the account spool.
3. The VS Code extension: read that variable instead of deriving the spool from
   `os.tmpdir()`, and install it per tenant under the account's extensions dir.
4. Mount `dsh-better-sidebar` in the profile (installed, not yet in `bundles`).
5. Deploy and verify from inside the sandbox.

Until 1–5 land, this fork behaves like upstream unless `tenant` is configured,
and a `tenant`-configured entry has no working browser half.

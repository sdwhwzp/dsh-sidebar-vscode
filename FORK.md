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

`tenant: { stateRoot, … }` in the loader entry turns both around:

- The built-in proxy is not mounted. The account's workbench is served by this
  package's own editor runtime (`runtime/`), which starts one code-server per
  account inside a bubblewrap sandbox on a private Unix socket and proxies it
  at `/dsh-vsceditor/`, checking the principal, the session's
  readability and the managed workspace root on every HTTP request and every
  WebSocket upgrade. `proxy.status` and `proxy.config` answer "not serving" so
  the browser half opens there rather than waiting for a mount.
- Every spool method authorizes first and answers from
  `<stateRoot>/<tenant>/data/dsh-sidebar-vscode`. The folder it uses is the
  authorized one, never the value the browser named.

That prefix is not this package's to choose: the passwords gateway allowlists
the paths it forwards and carries this one as a hardcoded entry. A route outside
the list still serves HTTP through the gateway's generic path but its WebSocket
upgrade is dropped, which the workbench reports only as a 1006 close — the name
therefore outlives the package it came from until the gateway moves first.

`runtime/` stays CommonJS and is loaded rather than rewritten. It is the
authorization and sandbox boundary, it was verified in production as shipped,
and a transcription into this package's TypeScript would be a defect class this
plugin cannot afford. Its root-owned launcher is `scripts/tenant-editor-launcher.py`;
sudoers pins that file by digest, so it is installed out of band and its content
is the deployment's contract, not this package's.

The gateway services `authorize` needs are acquired through a nested inject
rather than named in the top-level `inject`: a single-account composition has no
passwords gateway, and listing them there leaves the whole plugin pending
forever instead of running upstream behavior. A spool call arriving before those
services compose is refused, never served unauthorized.

## The reference queue

`navigator.clipboard` exists only in a secure context, so over plain HTTP the
workbench has no async clipboard, the clipboard bridge installs as a no-op, and
a "send selection" reaches nothing — silently, because the bridge's absence is
indistinguishable from a cross-origin editor. The extension therefore also
publishes every envelope to `refs.json` in the account's spool, and the tab
drains it through the authorized `ref.take` route. Reading clears the queue, so
an envelope arrives once; where both channels work, a payload delivered by
either is remembered for fifteen seconds and the other drops it.

This does not replace HTTPS. It removes the clipboard from the send path only;
the other secure-context limitations remain.

Remaining: the extension is installed per account by hand, so a NEW account
needs it copied into its extensions directory before the file-open channel
works there; the capability probe degrades to the URL-payload channel until
then.

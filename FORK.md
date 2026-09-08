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

Host half, browser half and the extension are done (472 tests). The browser half
asks `proxy.status` once per session: a `tenant: true` answer sends it to
`POST /dsh-vsceditor/open`, whose reply supplies both the iframe base
(`/dsh-vsceditor/ide/<sessionId>`) and the authorized folder, and every
open-channel call then carries that session. The extension takes its spool root
from `DSH_SIDEBAR_VSCODE_SPOOL` (extension 0.1.4) rather than deriving it from
`os.tmpdir()`, which a sandbox with a private /tmp cannot share with the host.

The gateway services `authorize` needs are acquired through a nested inject
rather than named in the top-level `inject`: a single-account composition has no
passwords gateway, and listing them there leaves the whole plugin pending
forever instead of running upstream behavior. A spool call arriving before those
services compose is refused, never served unauthorized.

Deployed and verified: both plugins mount under a real `dsh --profile web`,
`proxy.status` announces the mode, and an unauthorized session is refused by
both this plugin's spool route and dsh-vsceditor's own.

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
then. `dsh-vsceditor` also still registers its own conversation-view tab, so
both entry points open the same per-account instance.

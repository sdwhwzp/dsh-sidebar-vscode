'use strict'
/**
 * Filesystem plumbing of the extension side: the atomic marker write and
 * the spool-directory derivation every other module (channel.js, boot.js)
 * shares. The spool layout itself is defined by the shared protocol plane
 * (lib/protocol.js ↔ src/shared/protocol.ts, lockstep-pinned).
 */

const nodeFs = require('fs')
const nodeOs = require('os')
const nodePath = require('path')
const protocol = require('./protocol')

/** Best-effort atomic marker write (tmp + rename); failures are silent. */
function writeMarker (file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  nodeFs.writeFileSync(tmp, value)
  nodeFs.renameSync(tmp, file)
}

/** Per-account editor launchers provide an isolated spool inside the sandbox. */
function spoolRoot () {
  const supplied = process.env.DSH_SIDEBAR_VSCODE_SPOOL
  return typeof supplied === 'string' && supplied.startsWith('/')
    ? supplied
    : nodePath.join(nodeOs.tmpdir(), protocol.OPEN_CHANNEL_DIR)
}

/** The spool directory one workspace folder's channel lives in. */
function channelDirOf (folderPath) {
  return nodePath.join(spoolRoot(), protocol.slugOf(folderPath))
}

module.exports = { writeMarker, channelDirOf }

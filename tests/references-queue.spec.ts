/**
 * The reference queue: the channel that carries a send when the clipboard
 * bridge cannot exist, which is every plain-HTTP deployment.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { slugOf, takeReferences } from '../src/openChannel.ts'

const FOLDER = '/workspace/app'

/** A spool root holding one queue file for FOLDER. */
function spoolWith(content: string | undefined) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-refs-'))
  if (content !== undefined) {
    const dir = join(base, slugOf(FOLDER))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'refs.json'), content)
  }
  return base
}

describe('reference queue', () => {
  it('answers the queued envelopes oldest first and clears them', async () => {
    const base = spoolWith(JSON.stringify({
      v: 1,
      items: [{ at: 1, envelope: 'first' }, { at: 2, envelope: 'second' }],
    }))
    expect(await takeReferences(base, FOLDER)).toEqual(['first', 'second'])
    expect(await takeReferences(base, FOLDER)).toEqual([])
    expect(JSON.parse(readFileSync(join(base, slugOf(FOLDER), 'refs.json'), 'utf8')).items).toEqual([])
  })

  it('separates folders and answers empty for one that never sent', async () => {
    const base = spoolWith(JSON.stringify({ v: 1, items: [{ at: 1, envelope: 'only' }] }))
    expect(await takeReferences(base, '/workspace/other')).toEqual([])
    expect(await takeReferences(base, FOLDER)).toEqual(['only'])
  })

  it('tolerates an absent, half-written or malformed queue', async () => {
    expect(await takeReferences(spoolWith(undefined), FOLDER)).toEqual([])
    expect(await takeReferences(spoolWith('{"v":1,"items":[{"at":1,'), FOLDER)).toEqual([])
    expect(await takeReferences(spoolWith('{"v":1}'), FOLDER)).toEqual([])
    expect(await takeReferences(spoolWith(JSON.stringify({ v: 1, items: [{ at: 1 }, 7, null] })), FOLDER)).toEqual([])
  })
})

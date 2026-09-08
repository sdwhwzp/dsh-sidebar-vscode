/**
 * Per-account mode: configuration validation and the account-addressed spool.
 * The upstream spool is addressed by workspace folder alone, which is not an
 * identity once every tenant sees its own workspace at the same sandbox path.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { Config } from '../src/index.ts'
import { readTenantOptions, resolveTenantSpool, TENANT_SPOOL_DIRECTORY } from '../src/tenant.ts'

const REQUEST = {} as IncomingMessage

/** Authorization stub resolving whichever account the fixture names. */
function accessFor(bySession: Record<string, { tenant: string, folder: string }>) {
  return {
    async authorize(_ctx: unknown, _req: IncomingMessage, sessionId: string | null) {
      const target = sessionId === null ? undefined : bySession[sessionId]
      if (target === undefined) throw new Error('Session access denied')
      return { owner: '2', ...target }
    },
  }
}

describe('tenant options', () => {
  it('accepts an absolute state root and rejects everything else', () => {
    expect(readTenantOptions({ stateRoot: '/var/lib/dsh-vsceditor' })).toEqual({ stateRoot: '/var/lib/dsh-vsceditor' })
    expect(readTenantOptions(undefined)).toBeUndefined()
    expect(readTenantOptions(null)).toBeUndefined()
    expect(() => readTenantOptions({ stateRoot: 'relative' })).toThrow(/absolute/)
    expect(() => readTenantOptions({})).toThrow(/absolute/)
    expect(() => readTenantOptions([])).toThrow(/must be an object/)
  })

  it('is reached through the plugin config and its standard schema', () => {
    expect(Config({})).toEqual({})
    expect(Config({ tenant: { stateRoot: '/state' } })).toEqual({ tenant: { stateRoot: '/state' } })
    expect(Config['~standard'].validate({ tenant: { stateRoot: 'nope' } })).toHaveProperty('issues')
    expect(Config['~standard'].validate({})).toEqual({ value: {} })
  })
})

describe('account-addressed spool', () => {
  const access = accessFor({
    'session-a': { tenant: 'u2', folder: '/workspace/app' },
    'session-b': { tenant: 'u3', folder: '/workspace/app' },
  })
  const options = { stateRoot: '/var/lib/dsh-vsceditor' }

  it('separates two accounts whose sessions sit at the same sandbox path', async () => {
    const one = await resolveTenantSpool(access, {}, options, REQUEST, 'session-a')
    const two = await resolveTenantSpool(access, {}, options, REQUEST, 'session-b')
    expect(one.folder).toBe(two.folder)
    expect(one.base).not.toBe(two.base)
    expect(one.base).toBe(`/var/lib/dsh-vsceditor/u2/data/${TENANT_SPOOL_DIRECTORY}`)
    expect(two.base).toBe(`/var/lib/dsh-vsceditor/u3/data/${TENANT_SPOOL_DIRECTORY}`)
  })

  it('answers with the account own folder rather than anything the browser named', async () => {
    const resolved = await resolveTenantSpool(access, {}, options, REQUEST, 'session-a')
    expect(resolved).toEqual({
      base: `/var/lib/dsh-vsceditor/u2/data/${TENANT_SPOOL_DIRECTORY}`,
      folder: '/workspace/app',
      tenant: 'u2',
    })
  })

  it('refuses a session the principal may not read, and a missing session id', async () => {
    await expect(resolveTenantSpool(access, {}, options, REQUEST, 'session-other')).rejects.toThrow(/denied/)
    await expect(resolveTenantSpool(access, {}, options, REQUEST, null)).rejects.toThrow(/denied/)
  })
})

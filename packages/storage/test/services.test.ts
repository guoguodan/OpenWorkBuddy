import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDbResult } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { ensureWorkspace } from '../src/conversations.js'
import { getConnection, sanitizeEndpoint, setConnection } from '../src/services.js'

let dir: string
let handle: OpenDbResult
let workspaceId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-service-'))
  handle = openDatabase(join(dir, 'openwb.db'))
  migrateOrThrow(handle.raw, { dbPath: handle.path })
  workspaceId = ensureWorkspace(handle.db, join(dir, 'ws')).id
})

afterEach(async () => {
  handle.raw.close()
  await rm(dir, { recursive: true, force: true })
})

describe('service connection storage', () => {
  it('normalises endpoints to their origin', () => {
    expect(sanitizeEndpoint('https://mail.example.com/inbox?token=secret#top')).toBe(
      'https://mail.example.com'
    )
    expect(sanitizeEndpoint('http://127.0.0.1:8080/path')).toBe('http://127.0.0.1:8080')
  })

  it('rejects unsupported schemes and embedded credentials', () => {
    expect(sanitizeEndpoint('ftp://example.com')).toBeNull()
    expect(sanitizeEndpoint('not-a-url')).toBeNull()
    expect(sanitizeEndpoint('https://user:secret@example.com')).toBeNull()
    expect(sanitizeEndpoint('https://token@example.com')).toBeNull()
  })

  it('never persists a connected status without a valid endpoint', () => {
    const connection = setConnection(handle.db, {
      workspaceId,
      provider: 'mailbox',
      status: 'connected',
      endpoint: 'not-a-url',
      check: true
    })
    expect(connection.status).toBe('error')
    expect(connection.endpoint).toBeNull()
    expect(connection.lastError).toBe('连接地址无效')
  })

  it('clears the previous error when a later probe succeeds', () => {
    setConnection(handle.db, {
      workspaceId,
      provider: 'mailbox',
      status: 'error',
      endpoint: 'https://mail.example.com',
      lastError: '连接超时',
      check: true
    })
    const connection = setConnection(handle.db, {
      workspaceId,
      provider: 'mailbox',
      status: 'connected',
      endpoint: 'https://mail.example.com',
      lastError: null,
      check: true
    })
    expect(connection.status).toBe('connected')
    expect(connection.lastError).toBeNull()
    expect(getConnection(handle.db, workspaceId, 'mailbox')?.status).toBe('connected')
  })
})

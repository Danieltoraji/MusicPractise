import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadLibraryLevel } from './api'
import type { LibraryRecord } from '../library/db'

const REC: LibraryRecord = {
  id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
  kind: 'level',
  version: '1.0.0',
  title: '新手引导',
  doc: { schemaVersion: 3, kind: 'level', id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1', version: '1.0.0' },
  importedAt: 1,
  builtIn: 1,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('云盘客户端（uploadLibraryLevel）', () => {
  it('以 rec.id / rec.title / rec.doc 作为上传体', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ level: { id: 'cld_X' }, used: 1 })))
    vi.stubGlobal('fetch', fetchMock)
    const res = await uploadLibraryLevel(REC)
    expect(res.used).toBe(1)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/cloud/levels')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      levelId: REC.id,
      title: REC.title,
      payload: REC.doc,
    })
  })

  it('服务端错误信封原样抛出（中文消息直达 UI）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'cloud_full', message: '云盘已满（10 个槽位）' } }), { status: 409 })),
    )
    const err = await uploadLibraryLevel(REC).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'cloud_full', message: '云盘已满（10 个槽位）' })
  })
})

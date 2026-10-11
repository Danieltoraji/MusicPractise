import { apiFetch } from '../api/client'
import type { LibraryRecord } from '../library/db'

/** 云端槽位元数据（列表不含 payload；下载单独取） */
export interface CloudSlot {
  id: string
  levelId: string
  title: string
  bytes: number
  schemaVersion: number
  createdAt: number
  updatedAt: number
}

export const CLOUD_LIMIT = 10

/** 云盘端点类型化封装（docs/31 §5.2 契约）；上传/下载体积较大，超时放宽 */
export const cloudApi = {
  listSlots: (): Promise<{ levels: CloudSlot[]; used: number; limit: number }> => apiFetch('/api/cloud/levels'),
  upload: (levelId: string, title: string, payload: unknown): Promise<{ level: CloudSlot; used: number }> =>
    apiFetch('/api/cloud/levels', { method: 'POST', body: { levelId, title, payload }, timeoutMs: 20_000 }),
  getSlot: (id: string): Promise<{ level: CloudSlot & { payload: unknown } }> => apiFetch(`/api/cloud/levels/${id}`),
  deleteSlot: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/cloud/levels/${id}`, { method: 'DELETE' }),
}

/** 从资源库记录上传关卡：levelId = rec.id，payload = rec.doc（服务端校验两者一致） */
export async function uploadLibraryLevel(rec: LibraryRecord): Promise<{ level: CloudSlot; used: number }> {
  return cloudApi.upload(rec.id, rec.title, rec.doc)
}

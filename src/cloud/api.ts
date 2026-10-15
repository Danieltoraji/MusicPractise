import { apiFetch } from '../api/client'
import type { LibraryRecord } from '../library/db'
import { collectSeriesDocs } from '../library/manage'

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

/** 云端文件夹槽位元数据（docs/39 H2）：占用槽位 = levelCount */
export interface CloudFolder {
  id: string
  folderId: string
  title: string
  levelCount: number
  bytes: number
  createdAt: number
  updatedAt: number
}

export const CLOUD_LIMIT = 10

/** 云盘端点类型化封装（docs/31 §5.2 / docs/39 §5.1 契约）；上传/下载体积较大，超时放宽 */
export const cloudApi = {
  listSlots: (): Promise<{ levels: CloudSlot[]; folders: CloudFolder[]; used: number; limit: number }> => apiFetch('/api/cloud/levels'),
  upload: (levelId: string, title: string, payload: unknown): Promise<{ level: CloudSlot; used: number }> =>
    apiFetch('/api/cloud/levels', { method: 'POST', body: { levelId, title, payload }, timeoutMs: 20_000 }),
  getSlot: (id: string): Promise<{ level: CloudSlot & { payload: unknown } }> => apiFetch(`/api/cloud/levels/${id}`),
  deleteSlot: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/cloud/levels/${id}`, { method: 'DELETE' }),
  listFolders: (): Promise<{ folders: CloudFolder[] }> => apiFetch('/api/cloud/folders'),
  uploadFolder: (folderId: string, title: string, docs: { id: string; kind: string; payload: unknown }[]): Promise<{ folder: CloudFolder; used: number }> =>
    apiFetch('/api/cloud/folders', { method: 'POST', body: { folderId, title, docs }, timeoutMs: 60_000 }),
  getFolder: (id: string): Promise<{ folder: CloudFolder; docs: { id: string; kind: string; payload: unknown }[] }> =>
    apiFetch(`/api/cloud/folders/${id}`, { timeoutMs: 30_000 }),
  deleteFolder: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/cloud/folders/${id}`, { method: 'DELETE' }),
}

/** 从资源库记录上传关卡：levelId = rec.id，payload = rec.doc（服务端校验两者一致） */
export async function uploadLibraryLevel(rec: LibraryRecord): Promise<{ level: CloudSlot; used: number }> {
  return cloudApi.upload(rec.id, rec.title, rec.doc)
}

/** 从资源库记录上传整个系列（文件夹）：收集闭包文档，缺件/超槽位在本地即报可读错误 */
export async function uploadLibraryFolder(rec: LibraryRecord, all: LibraryRecord[]): Promise<{ folder: CloudFolder; used: number }> {
  const { docs, levelCount } = collectSeriesDocs(rec, all)
  if (levelCount > CLOUD_LIMIT) {
    throw new Error(`系列内含 ${levelCount} 个关卡，超过云盘 ${CLOUD_LIMIT} 个槽位上限`)
  }
  return cloudApi.uploadFolder(rec.id, rec.title, docs.map((d) => ({ id: d.id, kind: d.kind, payload: d.doc })))
}

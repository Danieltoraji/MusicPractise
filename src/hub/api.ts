import { apiFetch } from '../api/client'

/** 关卡库条目元数据（公共视角，docs/39 §5.2 契约） */
export interface HubItemMeta {
  id: string
  scope: string
  itemKind: 'level' | 'series'
  rootDocId: string
  title: string
  levelCount: number
  bytes: number
  authorName: string
  featured: boolean
  downloads: number
  publishedAt: number | null
}

/** 本人/审核视角附加字段（#/cloud 徽章数据源） */
export interface HubMineItem extends HubItemMeta {
  submitterNote: string | null
  wantFeatured: boolean
  status: 'pending' | 'published' | 'rejected'
  rejectReason: string | null
  createdAt: number
  updatedAt: number
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') out.set(k, String(v))
  }
  const s = out.toString()
  return s === '' ? '' : `?${s}`
}

/** 关卡库端点类型化封装（docs/39 §5.2 契约）；详情含全量快照，超时放宽 */
export const hubApi = {
  list: (params: { scope?: 'public' | 'official'; featured?: boolean; query?: string; limit?: number; offset?: number } = {}): Promise<{ items: HubItemMeta[]; total: number; limit: number; offset: number }> =>
    apiFetch(`/api/hub/items${qs({ scope: params.scope ?? 'public', featured: params.featured ? 1 : undefined, query: params.query, limit: params.limit, offset: params.offset })}`),
  get: (id: string): Promise<{ item: HubItemMeta; docs: { id: string; kind: string; payload: unknown }[] }> =>
    apiFetch(`/api/hub/items/${id}`, { timeoutMs: 30_000 }),
  mine: (): Promise<{ items: HubMineItem[] }> => apiFetch('/api/hub/mine'),
  withdraw: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/hub/items/${id}`, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// 群组（docs/39 §5.3，批次 H5）
// ---------------------------------------------------------------------------

export interface GroupMeta {
  id: string
  name: string
  joinCode: string
  intro: string | null
  ownerId: string
  status: 'active' | 'banned'
  createdAt: number
  myRole: 'owner' | 'reviewer' | 'member' | null
  memberCount: number
}

export interface GroupMember {
  userId: string
  nickname: string
  role: 'owner' | 'reviewer' | 'member'
  joinedAt: number
}

export interface GroupItem extends HubMineItem {
  submitterName: string
}

export interface GroupLookup {
  id: string
  name: string
  intro: string | null
  hasPassword: boolean
  memberCount: number
}

/** 群组端点类型化封装（docs/39 §5.3 契约） */
export const groupApi = {
  create: (body: { name: string; joinCode: string; password?: string; intro?: string }): Promise<{ group: GroupMeta }> =>
    apiFetch('/api/groups', { method: 'POST', body }),
  mine: (): Promise<{ groups: GroupMeta[] }> => apiFetch('/api/groups/mine'),
  lookup: (code: string): Promise<{ group: GroupLookup }> => apiFetch(`/api/groups/lookup?code=${encodeURIComponent(code)}`),
  join: (id: string, password?: string): Promise<{ ok: boolean; role: string }> =>
    apiFetch(`/api/groups/${id}/join`, { method: 'POST', body: password === undefined ? {} : { password } }),
  leave: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/groups/${id}/leave`, { method: 'POST' }),
  detail: (id: string): Promise<{ group: GroupMeta; members: GroupMember[] }> => apiFetch(`/api/groups/${id}`),
  update: (id: string, patch: { name?: string; joinCode?: string; password?: string; intro?: string | null }): Promise<{ group: GroupMeta }> =>
    apiFetch(`/api/groups/${id}`, { method: 'PATCH', body: patch }),
  disband: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/groups/${id}`, { method: 'DELETE' }),
  setMemberRole: (id: string, userId: string, role: 'reviewer' | 'member'): Promise<{ ok: boolean }> =>
    apiFetch(`/api/groups/${id}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeMember: (id: string, userId: string): Promise<{ ok: boolean }> => apiFetch(`/api/groups/${id}/members/${userId}`, { method: 'DELETE' }),
  listItems: (id: string): Promise<{ items: GroupItem[]; myRole: 'owner' | 'reviewer' | 'member' }> => apiFetch(`/api/groups/${id}/items`),
  uploadLevel: (id: string, levelId: string, title: string, payload: unknown): Promise<{ item: { id: string; status: string }; groupLevels: number }> =>
    apiFetch(`/api/groups/${id}/items`, { method: 'POST', body: { levelId, title, payload }, timeoutMs: 30_000 }),
  uploadSeries: (id: string, folderId: string, title: string, docs: { id: string; kind: string; payload: unknown }[]): Promise<{ item: { id: string; status: string }; groupLevels: number }> =>
    apiFetch(`/api/groups/${id}/items`, { method: 'POST', body: { folderId, title, docs }, timeoutMs: 60_000 }),
  approveItem: (id: string, itemId: string): Promise<{ ok: boolean; status: string }> =>
    apiFetch(`/api/groups/${id}/items/${itemId}/approve`, { method: 'POST', body: {} }),
  rejectItem: (id: string, itemId: string, reason: string): Promise<{ ok: boolean; status: string }> =>
    apiFetch(`/api/groups/${id}/items/${itemId}/reject`, { method: 'POST', body: { reason } }),
}

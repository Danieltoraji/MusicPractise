import { apiFetch } from '../api/client'

export interface AdminUser {
  id: string
  nickname: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  createdAt: number
}

export interface AdminLevel {
  id: string
  levelId: string
  title: string
  ownerNickname: string
  bytes: number
  updatedAt: number
}

export interface AuditEntry {
  id: string
  actorNickname: string | null
  action: string
  targetType: string
  targetId: string
  detail: Record<string, unknown> | null
  createdAt: number
}

export interface AdminStats {
  users: number
  cloudLevels: number
  activeSessions: number
}

export interface Paged {
  total: number
  limit: number
  offset: number
}

/** 关卡库条目（管理视角，docs/39 §5.2）：含提交者与审核状态机字段 */
export interface AdminHubItem {
  id: string
  scope: 'public' | 'official' | 'group'
  itemKind: 'level' | 'series'
  rootDocId: string
  title: string
  levelCount: number
  bytes: number
  submitterName: string
  submitterNote: string | null
  wantFeatured: boolean
  status: 'pending' | 'published' | 'rejected'
  featured: boolean
  rejectReason: string | null
  downloads: number
  createdAt: number
  updatedAt: number
}

/** 管理端点类型化封装（docs/31 §5.4 / docs/39 §5.2）；非 admin 一律 403，错误信封中文直达 */
export const adminApi = {
  stats: (): Promise<AdminStats> => apiFetch('/api/admin/stats'),
  listUsers: (query: string, offset = 0, limit = 20): Promise<{ users: AdminUser[] } & Paged> =>
    apiFetch(`/api/admin/users?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`),
  patchUser: (
    id: string,
    patch: { nickname?: string; status?: 'active' | 'disabled'; role?: 'user' | 'admin'; newPassword?: string },
  ): Promise<{ user: { id: string; nickname: string; role: 'user' | 'admin'; status: 'active' | 'disabled' } | null }> =>
    apiFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: patch }),
  deleteUser: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' }),
  listLevels: (query: string, offset = 0, limit = 20): Promise<{ levels: AdminLevel[] } & Paged> =>
    apiFetch(`/api/admin/levels?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`),
  deleteLevel: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/admin/levels/${id}`, { method: 'DELETE' }),
  listAudit: (offset = 0, limit = 20): Promise<{ entries: AuditEntry[] } & Paged> =>
    apiFetch(`/api/admin/audit?offset=${offset}&limit=${limit}`),
  listHub: (status: 'pending' | 'published' | 'rejected', query = '', offset = 0, limit = 20): Promise<{ items: AdminHubItem[] } & Paged> =>
    apiFetch(`/api/admin/hub?status=${status}&query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`),
  approveHub: (id: string, featured = false): Promise<{ ok: boolean; status: string; featured: boolean }> =>
    apiFetch(`/api/admin/hub/${id}/approve`, { method: 'POST', body: { featured } }),
  rejectHub: (id: string, reason: string): Promise<{ ok: boolean; status: string }> =>
    apiFetch(`/api/admin/hub/${id}/reject`, { method: 'POST', body: { reason } }),
  setHubFeatured: (id: string, featured: boolean): Promise<{ ok: boolean; featured: boolean }> =>
    apiFetch(`/api/admin/hub/${id}`, { method: 'PATCH', body: { featured } }),
  deleteHub: (id: string): Promise<{ ok: boolean }> => apiFetch(`/api/admin/hub/${id}`, { method: 'DELETE' }),
  createOfficialLevel: (levelId: string, title: string, payload: unknown): Promise<{ ok: boolean; item: { id: string } }> =>
    apiFetch('/api/admin/hub/official', { method: 'POST', body: { levelId, title, payload }, timeoutMs: 30_000 }),
  createOfficialSeries: (folderId: string, title: string, docs: { id: string; kind: string; payload: unknown }[]): Promise<{ ok: boolean; item: { id: string } }> =>
    apiFetch('/api/admin/hub/official', { method: 'POST', body: { folderId, title, docs }, timeoutMs: 60_000 }),
}

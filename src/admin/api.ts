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

/** 管理端点类型化封装（docs/31 §5.4）；非 admin 一律 403，错误信封中文直达 */
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
}

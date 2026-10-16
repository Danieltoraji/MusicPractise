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

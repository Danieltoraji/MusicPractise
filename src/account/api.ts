import { apiFetch } from '../api/client'

/** 服务端用户形态（与 worker/types.ts ApiUser 对齐，绝不包含 pw_hash） */
export interface ApiUser {
  id: string
  nickname: string
  role: 'user' | 'admin'
}

/** 认证端点类型化封装（docs/31 §5.1 契约）；注册/登录服务端有 PBKDF2 开销，超时放宽 */
export const accountApi = {
  health: (): Promise<{ ok: boolean }> => apiFetch('/api/health', { timeoutMs: 5_000 }),
  me: (): Promise<{ user: ApiUser | null }> => apiFetch('/api/auth/me'),
  register: (nickname: string, password: string): Promise<{ user: ApiUser }> =>
    apiFetch('/api/auth/register', { method: 'POST', body: { nickname, password }, timeoutMs: 15_000 }),
  login: (nickname: string, password: string): Promise<{ user: ApiUser }> =>
    apiFetch('/api/auth/login', { method: 'POST', body: { nickname, password }, timeoutMs: 15_000 }),
  logout: (): Promise<{ ok: boolean }> => apiFetch('/api/auth/logout', { method: 'POST' }),
  updateNickname: (nickname: string): Promise<{ user: ApiUser }> =>
    apiFetch('/api/auth/nickname', { method: 'PATCH', body: { nickname } }),
  changePassword: (oldPassword: string, newPassword: string): Promise<{ ok: boolean }> =>
    apiFetch('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } }),
}

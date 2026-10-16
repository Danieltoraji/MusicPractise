/**
 * MusicPractise Worker 入口（docs/31）：/api/* 进路由分发，其余路径回落静态资产。
 * 错误统一收口：HttpError → 对应状态码信封；未知错误 → 500 信封（不泄漏内部细节）。
 * 会话/认证路由在 handlers/auth.ts 注册（本文件只保留骨架与兜底）。
 */
import { errorJson, jsonResponse, withSecurityHeaders, HttpError } from './http'
import { Router } from './router'
import { changePassword, login, logout, me, register, updateNickname } from './handlers/auth'
import { deleteLevel, getLevel, listLevels, replaceLevel, uploadLevel } from './handlers/cloud'
import { deleteFolder, getFolder, listFolders, uploadFolder } from './handlers/cloud_folders'
import { getHubItem, listMine, listPublic, publishFolder, publishLevel, withdrawItem } from './handlers/hub'
import {
  approveGroupItem,
  createGroup,
  disbandGroup,
  groupDetail,
  joinGroup,
  leaveGroup,
  listGroupItems,
  lookupGroup,
  myGroups,
  rejectGroupItem,
  removeMember,
  setMemberRole,
  updateGroup,
  uploadGroupItem,
} from './handlers/groups'
import { listProgress, putProgress } from './handlers/progress'
import {
  adminApproveHub,
  adminCreateOfficial,
  adminDeleteGroup,
  adminDeleteHub,
  adminDeleteLevel,
  adminDeleteUser,
  adminListAudit,
  adminListGroups,
  adminListHub,
  adminListLevels,
  adminListUsers,
  adminPatchGroup,
  adminPatchHubFeatured,
  adminPatchUser,
  adminRejectHub,
  adminStats,
} from './handlers/admin'
import type { Env, ExecutionContext } from './types'

const api = new Router()

api.add('GET', '/api/health', () => jsonResponse({ ok: true, time: Date.now() }))

api.add('POST', '/api/auth/register', register)
api.add('POST', '/api/auth/login', login)
api.add('POST', '/api/auth/logout', logout)
api.add('GET', '/api/auth/me', me)
api.add('PATCH', '/api/auth/nickname', updateNickname)
api.add('POST', '/api/auth/password', changePassword)

api.add('GET', '/api/cloud/levels', listLevels)
api.add('POST', '/api/cloud/levels', uploadLevel)
api.add('GET', '/api/cloud/levels/:id', getLevel)
api.add('PUT', '/api/cloud/levels/:id', replaceLevel)
api.add('DELETE', '/api/cloud/levels/:id', deleteLevel)

api.add('GET', '/api/cloud/folders', listFolders)
api.add('POST', '/api/cloud/folders', uploadFolder)
api.add('GET', '/api/cloud/folders/:id', getFolder)
api.add('DELETE', '/api/cloud/folders/:id', deleteFolder)

api.add('POST', '/api/cloud/levels/:id/publish', publishLevel)
api.add('POST', '/api/cloud/folders/:id/publish', publishFolder)

api.add('GET', '/api/hub/items', listPublic)
api.add('GET', '/api/hub/items/:id', getHubItem)
api.add('GET', '/api/hub/mine', listMine)
api.add('DELETE', '/api/hub/items/:id', withdrawItem)

api.add('POST', '/api/groups', createGroup)
api.add('GET', '/api/groups/mine', myGroups)
api.add('GET', '/api/groups/lookup', lookupGroup)
api.add('GET', '/api/groups/:id', groupDetail)
api.add('PATCH', '/api/groups/:id', updateGroup)
api.add('DELETE', '/api/groups/:id', disbandGroup)
api.add('POST', '/api/groups/:id/join', joinGroup)
api.add('POST', '/api/groups/:id/leave', leaveGroup)
api.add('GET', '/api/groups/:id/items', listGroupItems)
api.add('POST', '/api/groups/:id/items', uploadGroupItem)
api.add('POST', '/api/groups/:id/items/:itemId/approve', approveGroupItem)
api.add('POST', '/api/groups/:id/items/:itemId/reject', rejectGroupItem)
api.add('PATCH', '/api/groups/:id/members/:uid', setMemberRole)
api.add('DELETE', '/api/groups/:id/members/:uid', removeMember)

api.add('GET', '/api/progress', listProgress)
api.add('PUT', '/api/progress', putProgress)

api.add('GET', '/api/admin/stats', adminStats)
api.add('GET', '/api/admin/users', adminListUsers)
api.add('PATCH', '/api/admin/users/:id', adminPatchUser)
api.add('DELETE', '/api/admin/users/:id', adminDeleteUser)
api.add('GET', '/api/admin/levels', adminListLevels)
api.add('DELETE', '/api/admin/levels/:id', adminDeleteLevel)
api.add('GET', '/api/admin/audit', adminListAudit)

api.add('GET', '/api/admin/groups', adminListGroups)
api.add('PATCH', '/api/admin/groups/:id', adminPatchGroup)
api.add('DELETE', '/api/admin/groups/:id', adminDeleteGroup)
api.add('GET', '/api/admin/hub', adminListHub)
api.add('POST', '/api/admin/hub/official', adminCreateOfficial)
api.add('PATCH', '/api/admin/hub/:id', adminPatchHubFeatured)
api.add('DELETE', '/api/admin/hub/:id', adminDeleteHub)
api.add('POST', '/api/admin/hub/:id/approve', adminApproveHub)
api.add('POST', '/api/admin/hub/:id/reject', adminRejectHub)

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(req.url)
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const res = await api.handle(req, env)
        return withSecurityHeaders(res ?? errorJson(404, 'not_found', '接口不存在'))
      }
      return withSecurityHeaders(await env.ASSETS.fetch(req))
    } catch (err) {
      if (err instanceof HttpError) return withSecurityHeaders(errorJson(err.status, err.code, err.message))
      console.error('[api] 未处理错误:', err)
      return withSecurityHeaders(errorJson(500, 'internal', '服务内部错误，请稍后再试'))
    }
  },
}

/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 项目页部署在仓库子路径下：CI 传 VITE_BASE=/MusicPractise/，
// 本地开发/预览缺省 '/'，互不影响
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    // react 全家桶独立 vendor chunk：业务发版时浏览器缓存命中（批次11 Bundle 瘦身）。
    // advancedChunks 已被 Vite 8 弃用（构建警告），迁移到 codeSplitting（docs/40 H3）
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'react-vendor', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: {
    // Windows 下 chokidar 可能漏文件事件（表现为浏览器持续运行旧模块），轮询监视更可靠
    watch: {
      usePolling: true,
      interval: 300,
    },
    // 本地全栈开发（docs/31 §3.4）：/api 转发到 wrangler dev（npm run dev:worker，默认端口 8787）
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  test: {
    environment: 'node',
    // H6（docs/40）：全局 setup 基座——React ACT 标记/指针捕获兜底等 jsdom 通用 stub
    // 对 node 环境测试无副作用；逐文件样板渐进迁移
    setupFiles: ['./src/test/setup.ts'],
  },
})

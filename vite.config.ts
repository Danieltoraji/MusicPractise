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
    // react 全家桶独立 vendor chunk：业务发版时浏览器缓存命中（批次11 Bundle 瘦身）
    rolldownOptions: {
      output: {
        advancedChunks: {
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
  },
})

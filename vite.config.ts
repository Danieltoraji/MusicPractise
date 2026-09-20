/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 项目页部署在仓库子路径下：CI 传 VITE_BASE=/MusicPractise/，
// 本地开发/预览缺省 '/'，互不影响
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // Windows 下 chokidar 可能漏文件事件（表现为浏览器持续运行旧模块），轮询监视更可靠
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  test: {
    environment: 'node',
  },
})

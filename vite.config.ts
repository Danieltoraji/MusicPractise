/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
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

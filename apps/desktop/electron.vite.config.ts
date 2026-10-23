import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    // @openwb/* 的 main 指向 .ts 源码,必须内联进主进程产物
    plugins: [externalizeDepsPlugin({ exclude: ['@openwb/protocol'] })]
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve(__dirname, '../renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, '../renderer/index.html')
      }
    },
    server: { port: 5199, strictPort: true }
  }
})
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'es2022',
  sourcemap: true,
  // 第三方包保持 external:其中 yaml 等 CJS 包一旦内联到 ESM 就会触发 Dynamic require
  external: ['better-sqlite3', 'ai', '@ai-sdk/openai', 'zod', 'yaml', 'dotenv'],
  // @openwb/* 的 main 指向 .ts 源码,必须内联打包才能被 node 直接运行
  noExternal: ['@openwb/prompt', '@openwb/tools', '@openwb/skills']
})

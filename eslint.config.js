import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['apps/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['node:*', 'electron', 'better-sqlite3'],
          message: '渲染进程不得访问 Node/Electron/数据库,请通过 preload 暴露的 API'
        }]
      }]
    }
  },
  {
    files: ['apps/daemon/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['electron'], message: 'daemon 不得依赖 Electron API' }]
      }]
    }
  }
)

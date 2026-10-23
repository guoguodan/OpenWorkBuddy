import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createOpenAI } from '@ai-sdk/openai'

function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.OPENWB_ENV_FILE,
    resolve(process.cwd(), '.env'),
    resolve(here, '../../../.env'),
    resolve(here, '../../.env')
  ]
  for (const path of candidates) {
    if (path && existsSync(path)) {
      config({ path })
      return
    }
  }
}

loadEnv()

const provider = createOpenAI({
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {})
})

export const model = provider(process.env.OPENWB_MODEL ?? 'gpt-4o-mini')

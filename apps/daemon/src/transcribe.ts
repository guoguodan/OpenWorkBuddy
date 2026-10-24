/**
 * 语音转写。
 *
 * 录音发生在渲染进程(需要浏览器媒体权限),转写必须走 daemon:
 * 只有 daemon 持有网关地址与密钥,渲染进程不应接触 API Key。
 * 帧协议上限 8MB,base64 会膨胀约 4/3,所以原始音频限制在 4MB。
 */

export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4
const TRANSCRIBE_TIMEOUT_MS = 60_000

export const VOICE_MESSAGES = {
  empty: '未检测到语音内容，请重试。',
  invalidAudio: '录音数据无效，请重试。',
  tooLarge: '录音过长，请缩短后重试。',
  failed: '语音识别失败，请重试。',
  timeout: '语音识别超时，请重试。',
  unsupported: '当前环境不支持语音输入。',
  notConfigured: '语音识别未配置网关，请检查 OPENAI_BASE_URL。'
} as const

export class TranscribeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'TranscribeError'
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav'
}

function normalizeMime(raw: string): string {
  return raw.split(';')[0]!.trim().toLowerCase()
}

/** 严格解码:拒绝空白、非法字符和超限数据,避免把坏音频发给网关。 */
export function decodeAudioBase64(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0) {
    throw new TranscribeError(VOICE_MESSAGES.invalidAudio, 'INVALID_AUDIO')
  }
  if (data.length > MAX_BASE64_CHARS) {
    throw new TranscribeError(VOICE_MESSAGES.tooLarge, 'AUDIO_TOO_LARGE')
  }
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new TranscribeError(VOICE_MESSAGES.invalidAudio, 'INVALID_AUDIO')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw new TranscribeError(
      bytes.length > MAX_AUDIO_BYTES ? VOICE_MESSAGES.tooLarge : VOICE_MESSAGES.invalidAudio,
      bytes.length > MAX_AUDIO_BYTES ? 'AUDIO_TOO_LARGE' : 'INVALID_AUDIO'
    )
  }
  return bytes
}

export interface TranscribeInput {
  data: unknown
  mimeType?: unknown
}

export interface TranscribeResult {
  text: string
  model: string
  mocked: boolean
}

interface TranscriptionBody {
  text?: unknown
}

/**
 * 调网关 `/audio/transcriptions`。
 *
 * 错误只抛出可直接展示的中文文案,不把网关原始 response body 透给用户:
 * 其中可能含内部地址或计费信息。诊断信息写到 stderr。
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  const bytes = decodeAudioBase64(input.data)
  const mime =
    typeof input.mimeType === 'string' && input.mimeType.trim()
      ? normalizeMime(input.mimeType)
      : 'audio/webm'
  const extension = MIME_EXTENSIONS[mime]
  if (!extension) {
    throw new TranscribeError(VOICE_MESSAGES.unsupported, 'UNSUPPORTED_AUDIO')
  }

  const model = process.env.OPENWB_TRANSCRIBE_MODEL?.trim() || 'whisper-1'

  // 离线/E2E 模式不访问网关:界面链路仍要能完整走通。
  if (process.env.OPENWB_MOCK === '1') {
    return { text: '这是一段语音识别结果', model, mocked: true }
  }

  const base = process.env.OPENAI_BASE_URL?.trim()
  if (!base) {
    throw new TranscribeError(VOICE_MESSAGES.notConfigured, 'NOT_CONFIGURED')
  }
  const key = process.env.OPENAI_API_KEY?.trim()

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `voice.${extension}`)
  form.append('model', model)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      body: form,
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      process.stderr.write(
        `[voice] transcribe failed status=${response.status} body=${detail.slice(0, 300)}\n`
      )
      throw new TranscribeError(VOICE_MESSAGES.failed, 'ASR_FAILED')
    }
    const body = (await response.json().catch(() => null)) as TranscriptionBody | null
    if (!body || typeof body.text !== 'string') {
      throw new TranscribeError(VOICE_MESSAGES.failed, 'ASR_FAILED')
    }
    return { text: body.text.trim(), model, mocked: false }
  } catch (err) {
    if (err instanceof TranscribeError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new TranscribeError(VOICE_MESSAGES.timeout, 'ASR_TIMEOUT')
    }
    process.stderr.write(`[voice] transcribe error: ${(err as Error).message}\n`)
    throw new TranscribeError(VOICE_MESSAGES.failed, 'ASR_FAILED')
  } finally {
    clearTimeout(timer)
  }
}

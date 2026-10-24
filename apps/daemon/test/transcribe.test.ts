import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeAudioBase64,
  MAX_AUDIO_BYTES,
  transcribeAudio,
  VOICE_MESSAGES
} from '../src/transcribe.js'

const AUDIO = Buffer.from('fake-webm-bytes')
const AUDIO_BASE64 = AUDIO.toString('base64')
let originalFetch: typeof fetch
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  originalFetch = globalThis.fetch
  savedEnv = { ...process.env }
  process.env.OPENAI_BASE_URL = 'http://gateway.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENWB_MOCK
  delete process.env.OPENWB_TRANSCRIBE_MODEL
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = savedEnv
  vi.restoreAllMocks()
})

describe('decodeAudioBase64', () => {
  it('接受合法 base64 并还原字节', () => {
    expect(decodeAudioBase64(AUDIO_BASE64).equals(AUDIO)).toBe(true)
  })

  it('拒绝空数据和非法类型', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      expect(() => decodeAudioBase64(bad)).toThrow(VOICE_MESSAGES.invalidAudio)
    }
  })

  it('拒绝非法字符和错误长度', () => {
    expect(() => decodeAudioBase64('!!!!')).toThrow(VOICE_MESSAGES.invalidAudio)
    expect(() => decodeAudioBase64('abc')).toThrow(VOICE_MESSAGES.invalidAudio)
  })

  it('超过 4MB 直接拒绝', () => {
    const oversized = Buffer.alloc(MAX_AUDIO_BYTES + 3).toString('base64')
    expect(() => decodeAudioBase64(oversized)).toThrow(VOICE_MESSAGES.tooLarge)
  })
})

describe('transcribeAudio', () => {
  it('把音频和模型发给转写接口并返回文本', async () => {
    let capturedUrl = ''
    let capturedBody: FormData | null = null
    let capturedAuth = ''
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = init?.body as FormData
      capturedAuth = String((init?.headers as Record<string, string>)?.authorization ?? '')
      return new Response(JSON.stringify({ text: '  你好 世界  ' }), { status: 200 })
    }) as typeof fetch

    const result = await transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm;codecs=opus' })

    expect(result.text).toBe('你好 世界')
    expect(result.model).toBe('whisper-1')
    expect(result.mocked).toBe(false)
    expect(capturedUrl).toBe('http://gateway.test/v1/audio/transcriptions')
    expect(capturedAuth).toBe('Bearer test-key')
    expect(capturedBody?.get('model')).toBe('whisper-1')
    const file = capturedBody?.get('file') as File
    expect(file.name).toBe('voice.webm')
    expect(file.type).toBe('audio/webm')
  })

  it('支持用环境变量切换转写模型', async () => {
    process.env.OPENWB_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'
    let model = ''
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      model = String((init?.body as FormData).get('model'))
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    }) as typeof fetch

    const result = await transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm' })
    expect(model).toBe('gpt-4o-mini-transcribe')
    expect(result.model).toBe('gpt-4o-mini-transcribe')
  })

  it('不支持的音频格式在发请求前就报错', async () => {
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(transcribeAudio({ data: AUDIO_BASE64, mimeType: 'video/mp4' })).rejects.toThrow(
      VOICE_MESSAGES.unsupported
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('网关失败映射为标准文案', async () => {
    globalThis.fetch = (async () =>
      new Response('internal detail', { status: 500 })) as typeof fetch
    await expect(transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm' })).rejects.toThrow(
      VOICE_MESSAGES.failed
    )
  })

  it('网关返回非 JSON 时按失败处理', async () => {
    globalThis.fetch = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch
    await expect(transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm' })).rejects.toThrow(
      VOICE_MESSAGES.failed
    )
  })

  it('空识别结果原样返回空串', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: '   ' }), { status: 200 })) as typeof fetch
    const result = await transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm' })
    expect(result.text).toBe('')
  })

  it('未配置网关时给出可操作提示', async () => {
    delete process.env.OPENAI_BASE_URL
    await expect(transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm' })).rejects.toThrow(
      VOICE_MESSAGES.notConfigured
    )
  })

  it('离线模式不访问网关', async () => {
    process.env.OPENWB_MOCK = '1'
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch
    const result = await transcribeAudio({ data: AUDIO_BASE64, mimeType: 'audio/webm' })
    expect(spy).not.toHaveBeenCalled()
    expect(result.mocked).toBe(true)
    expect(result.text).toBe('这是一段语音识别结果')
  })
})
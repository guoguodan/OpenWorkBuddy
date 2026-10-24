import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceState = 'idle' | 'recording' | 'processing'

export const VOICE_TEXT = {
  start: '语音输入',
  hint: '点击或长按 ALT 语音输入',
  stop: '停止录制',
  cancel: '取消录制',
  processing: '识别中...',
  permissionDenied: '麦克风权限被拒绝，请在系统设置中授权。',
  noDevice: '未检测到可用的麦克风设备。',
  deviceBusy: '麦克风正被其他应用占用。',
  unknown: '录音启动失败。',
  asrFailed: '语音识别失败，请重试。',
  timeout: '语音识别超时，请重试。',
  notSupported: '当前环境不支持语音输入。',
  emptyResult: '未检测到语音内容，请重试。',
  tooLarge: '录音过长，请缩短后重试。'
} as const

/** 4MB 原始音频在 base64 后约 5.4MB,留出 JSON 封装余量。 */
const MAX_RECORD_MS = 120_000

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function startErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return VOICE_TEXT.permissionDenied
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return VOICE_TEXT.noDevice
  if (name === 'NotReadableError' || name === 'AbortError') return VOICE_TEXT.deviceBusy
  return VOICE_TEXT.unknown
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  // 分块拼接,避免大数组 spread 触发调用栈上限。
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export interface VoiceInputOptions {
  disabled: boolean
  onText: (text: string) => void
  onError: (message: string) => void
}

/**
 * 语音输入状态机。
 *
 * 录音权限与 MediaRecorder 都只在渲染进程可用,转写则必须经主进程交给 daemon:
 * 渲染层拿不到网关密钥。这里只负责采集、状态与错误文案,不猜识别结果。
 */
export function useVoiceInput({ disabled, onText, onError }: VoiceInputOptions) {
  const [state, setState] = useState<VoiceState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)
  // 回调放进 ref:录音是跨多帧的异步流程,闭包里的旧 props 会把文本写回旧位置。
  const onTextRef = useRef(onText)
  const onErrorRef = useRef(onError)
  onTextRef.current = onText
  onErrorRef.current = onError

  const release = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }, [])

  const transcribe = useCallback(async (blob: Blob, durationMs: number) => {
    setState('processing')
    try {
      if (blob.size === 0) {
        onErrorRef.current(VOICE_TEXT.emptyResult)
        return
      }
      const data = await blobToBase64(blob)
      const result = await window.openwb.voice.transcribe({
        data,
        mimeType: blob.type || 'audio/webm',
        durationMs
      })
      const text = result.text.trim()
      if (!text) {
        onErrorRef.current(VOICE_TEXT.emptyResult)
        return
      }
      onTextRef.current(text)
    } catch (err) {
      const message = (err as Error)?.message || VOICE_TEXT.asrFailed
      onErrorRef.current(message)
    } finally {
      setState('idle')
      setElapsedMs(0)
    }
  }, [])

  const finish = useCallback(
    (cancelled: boolean) => {
      const recorder = recorderRef.current
      if (!recorder) return
      cancelledRef.current = cancelled
      const durationMs = Date.now() - startedAtRef.current
      if (recorder.state !== 'inactive') recorder.stop()
      // onstop 里再切状态;这里先停止计时,避免识别期间数字继续跳。
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
      if (maxTimerRef.current !== null) {
        window.clearTimeout(maxTimerRef.current)
        maxTimerRef.current = null
      }
      recorder.onstop = () => {
        const chunks = chunksRef.current
        const mimeType = recorder.mimeType || 'audio/webm'
        release()
        if (cancelledRef.current) {
          setState('idle')
          setElapsedMs(0)
          return
        }
        void transcribe(new Blob(chunks, { type: mimeType }), durationMs)
      }
    },
    [release, transcribe]
  )

  const start = useCallback(async () => {
    if (disabled || state !== 'idle') return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current(VOICE_TEXT.notSupported)
      return
    }
    const mimeType = pickMimeType()
    if (!mimeType) {
      onErrorRef.current(VOICE_TEXT.notSupported)
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      onErrorRef.current(startErrorMessage(err))
      return
    }
    try {
      const recorder = new MediaRecorder(stream, { mimeType })
      recorderRef.current = recorder
      streamRef.current = stream
      chunksRef.current = []
      cancelledRef.current = false
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        release()
        setState('idle')
        setElapsedMs(0)
        onErrorRef.current(VOICE_TEXT.unknown)
      }
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      setState('recording')
      recorder.start(250)
      timerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current)
      }, 200)
      // 超长录音会超过帧协议上限;到点自动结束并照常转写。
      maxTimerRef.current = window.setTimeout(() => finish(false), MAX_RECORD_MS)
    } catch (err) {
      for (const track of stream.getTracks()) track.stop()
      onErrorRef.current(startErrorMessage(err))
    }
  }, [disabled, finish, release, state])

  const stop = useCallback(() => {
    if (state !== 'recording') return
    finish(false)
  }, [finish, state])

  const cancel = useCallback(() => {
    if (state !== 'recording') return
    finish(true)
  }, [finish, state])

  const toggle = useCallback(() => {
    if (state === 'idle') void start()
    else if (state === 'recording') stop()
  }, [start, state, stop])

  useEffect(() => release, [release])

  return { state, elapsedMs, start, stop, cancel, toggle }
}

export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const PROTOCOL_VERSION = 2

export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** 4 字节大端长度 + UTF-8 JSON 负载 */
export function encodeFrame(value: unknown): Buffer {
  const json = JSON.stringify(value)
  if (json === undefined) throw new FrameError('frame payload is not serializable')
  const payload = Buffer.from(json, 'utf8')
  if (payload.length === 0) throw new FrameError('empty frame')
  if (payload.length > MAX_FRAME_BYTES) {
    throw new FrameError(`frame too large: ${payload.length} > ${MAX_FRAME_BYTES}`)
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

/**
 * 增量解码器:一次投递可能只有半个帧,也可能含多帧。
 * 长度声明必须落在 (0, MAX_FRAME_BYTES],否则视为协议错误立即抛。
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return []
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])

    const out: unknown[] = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len === 0) throw new FrameError('empty frame')
      if (len > MAX_FRAME_BYTES) throw new FrameError(`bad frame length: ${len}`)
      if (this.buf.length < 4 + len) break
      const json = this.buf.subarray(4, 4 + len).toString('utf8')
      this.buf = this.buf.subarray(4 + len)
      let value: unknown
      try {
        value = JSON.parse(json)
      } catch (err) {
        throw new FrameError(`invalid JSON frame: ${(err as Error).message}`)
      }
      out.push(value)
    }
    return out
  }

  /** 流结束时若还有残留字节,说明对端截断 */
  finish(): void {
    if (this.buf.length !== 0) {
      throw new FrameError(`truncated frame: ${this.buf.length} trailing bytes`)
    }
  }

  get pendingBytes(): number {
    return this.buf.length
  }
}

export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
}

export function helloFrame(): HelloFrame {
  return { type: 'hello', protocolVersion: PROTOCOL_VERSION }
}

export function assertHello(value: unknown): HelloFrame {
  const frame = value as Partial<HelloFrame> | null
  if (!frame || frame.type !== 'hello') throw new FrameError('first frame must be hello')
  if (frame.protocolVersion !== PROTOCOL_VERSION) {
    throw new FrameError(
      `协议版本不一致: daemon=${String(frame.protocolVersion)} client=${PROTOCOL_VERSION}`
    )
  }
  return frame as HelloFrame
}
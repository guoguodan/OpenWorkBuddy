import { describe, expect, it } from 'vitest'
import {
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  assertHello,
  encodeFrame,
  helloFrame
} from '../src/framing.js'

describe('encodeFrame', () => {
  it('writes a 4-byte big-endian length header', () => {
    const frame = encodeFrame({ a: 1 })
    const payload = Buffer.from(JSON.stringify({ a: 1 }), 'utf8')
    expect(frame.readUInt32BE(0)).toBe(payload.length)
    expect(frame.subarray(4).toString('utf8')).toBe(JSON.stringify({ a: 1 }))
  })

  it('rejects an empty payload', () => {
    expect(() => encodeFrame(undefined)).toThrow(FrameError)
  })

  it('rejects payloads above the limit', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1)
    expect(() => encodeFrame({ huge })).toThrow(/too large/)
  })
})

describe('FrameDecoder', () => {
  it('reassembles a frame delivered one byte at a time', () => {
    const value = { type: 'text', text: '你好 world 🚀' }
    const frame = encodeFrame(value)
    const decoder = new FrameDecoder()
    const out: unknown[] = []
    for (const byte of frame) {
      out.push(...decoder.push(Buffer.from([byte])))
    }
    expect(out).toEqual([value])
    expect(decoder.pendingBytes).toBe(0)
  })

  it('decodes three frames from a single chunk in order', () => {
    const values = [{ n: 1 }, { n: 2 }, { n: 3 }]
    const chunk = Buffer.concat(values.map((v) => encodeFrame(v)))
    expect(new FrameDecoder().push(chunk)).toEqual(values)
  })

  it('keeps newlines, Chinese and emoji intact', () => {
    const value = { text: 'line1\nline2\n中文内容 😀🎉', nested: { s: 'a\nb' } }
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame(value))).toEqual([value])
  })

  it('throws when the declared length exceeds the limit', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => new FrameDecoder().push(header)).toThrow(/bad frame length/)
  })

  it('throws on a zero-length frame', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(0, 0)
    expect(() => new FrameDecoder().push(header)).toThrow(/empty frame/)
  })

  it('reports truncated trailing bytes at end of stream', () => {
    const decoder = new FrameDecoder()
    decoder.push(encodeFrame({ a: 1 }).subarray(0, 6))
    expect(() => decoder.finish()).toThrow(/truncated/)
  })

  it('recovers frames split across an arbitrary boundary', () => {
    const a = encodeFrame({ a: 'x'.repeat(50) })
    const b = encodeFrame({ b: '中文'.repeat(20) })
    const all = Buffer.concat([a, b])
    const decoder = new FrameDecoder()
    const first = decoder.push(all.subarray(0, 17))
    const second = decoder.push(all.subarray(17))
    expect([...first, ...second]).toEqual([
      { a: 'x'.repeat(50) },
      { b: '中文'.repeat(20) }
    ])
  })
})

describe('handshake', () => {
  it('accepts the matching protocol version', () => {
    expect(assertHello(helloFrame()).protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('rejects a mismatched protocol version', () => {
    expect(() => assertHello({ type: 'hello', protocolVersion: 1 })).toThrow(/协议版本不一致/)
  })

  it('rejects a non-hello first frame', () => {
    expect(() => assertHello({ type: 'ready' })).toThrow(/must be hello/)
  })
})
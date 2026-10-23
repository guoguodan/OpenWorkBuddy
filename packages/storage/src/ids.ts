const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID:48 位毫秒时间戳 + 80 位随机,26 字符,字典序即时间序 */
export function ulid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time
    t = Math.floor(t / 32)
  }
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  let rand = ''
  // 80 位 -> 16 个 base32 字符
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      rand += CROCKFORD[(acc >> (bits - 5)) & 31]!
      bits -= 5
    }
  }
  if (bits > 0) rand += CROCKFORD[(acc << (5 - bits)) & 31]!
  return time + rand.slice(0, 16)
}

export function nowIso(): string {
  return new Date().toISOString()
}
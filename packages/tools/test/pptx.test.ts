import { describe, expect, it } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { buildDeck } from '../src/pptx.js'

/** 最小 ZIP 读取:只解析中央目录并解压单个部件,足够验证 OOXML 结构。 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('没有找到 EOCD')
  const total = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  for (let index = 0; index < total; index++) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50)
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtra = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtra
    const raw = buf.subarray(start, start + compressedSize)
    files.set(name, method === 8 ? inflateRawSync(raw) : raw)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

const deck = buildDeck({
  title: 'RAG 技术汇报',
  subtitle: '原理、架构与落地',
  slides: [
    { title: '封面' },
    { title: '为什么需要 RAG', bullets: [{ text: '幻觉' }, { text: '时效' }, { text: '私有数据' }] },
    { title: '架构', bullets: [{ text: '离线索引' }, { text: '检索', level: 2 }, { text: '生成' }] }
  ]
})

describe('buildDeck', () => {
  it('产出合法的 ZIP 与必需部件', () => {
    const files = readZip(deck.buffer)
    const required = [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml'
    ]
    for (const name of required) expect(files.has(name), name).toBe(true)
    expect(deck.slideCount).toBe(3)
  })

  it('每张幻灯片都有对应关系文件,避免 PowerPoint 提示修复', () => {
    const files = readZip(deck.buffer)
    for (let index = 1; index <= deck.slideCount; index++) {
      expect(files.has(`ppt/slides/_rels/slide${index}.xml.rels`)).toBe(true)
    }
    const presentationRels = files.get('ppt/_rels/presentation.xml.rels')!.toString('utf8')
    for (let index = 1; index <= deck.slideCount; index++) {
      expect(presentationRels).toContain(`slides/slide${index}.xml`)
    }
  })

  it('正文与标题进入对应的幻灯片 XML', () => {
    const files = readZip(deck.buffer)
    // 第一页是封面:标题取 slides[0].title,副标题取 DeckSpec.subtitle
    const cover = files.get('ppt/slides/slide1.xml')!.toString('utf8')
    expect(cover).toContain('封面')
    expect(cover).toContain('原理、架构与落地')
    const second = files.get('ppt/slides/slide2.xml')!.toString('utf8')
    expect(second).toContain('为什么需要 RAG')
    expect(second).toContain('私有数据')
  })

  it('转义 XML 特殊字符,不产生可执行标记', () => {
    const risky = buildDeck({
      title: '<script>alert(1)</script>',
      slides: [{ title: '<script>alert(1)</script>', bullets: [{ text: '<b>x</b>' }] }]
    })
    const xml = readZip(risky.buffer).get('ppt/slides/slide1.xml')!.toString('utf8')
    expect(xml).not.toContain('<script>')
    expect(xml).toContain('&lt;script&gt;')
  })

  it('相同输入产出逐字节一致的文件', () => {
    const again = buildDeck({
      title: 'RAG 技术汇报',
      subtitle: '原理、架构与落地',
      slides: [
        { title: '封面' },
        { title: '为什么需要 RAG', bullets: [{ text: '幻觉' }, { text: '时效' }, { text: '私有数据' }] },
        { title: '架构', bullets: [{ text: '离线索引' }, { text: '检索', level: 2 }, { text: '生成' }] }
      ]
    })
    expect(again.buffer.equals(deck.buffer)).toBe(true)
  })

  // 回归:第一页套封面版式时,曾把这一页的要点静默丢掉
  it('第一页的要点进入封面页而不是被覆盖', () => {
    const withBullets = buildDeck({
      title: '季度回顾',
      slides: [{ title: '季度回顾', bullets: [{ text: '营收增长 18%' }] }, { title: '下一步' }]
    })
    const first = readZip(withBullets.buffer).get('ppt/slides/slide1.xml')!.toString('utf8')
    expect(first).toContain('季度回顾')
    expect(first).toContain('营收增长 18%')
  })

  // 页数必须与 slides 一致:用户要 10 页,不能变成 11 页
  it('不额外追加封面页', () => {
    const extra = buildDeck({
      title: '季度回顾',
      subtitle: '2026 Q3',
      slides: [{ title: '第一部分' }, { title: '第二部分' }]
    })
    expect(extra.slideCount).toBe(2)
    const files = readZip(extra.buffer)
    expect(files.get('ppt/slides/slide1.xml')!.toString('utf8')).toContain('2026 Q3')
    expect(files.get('ppt/slides/slide2.xml')!.toString('utf8')).toContain('第二部分')
  })
  it('没有幻灯片时仍生成一页封面', () => {
    const single = buildDeck({ title: '只有封面', slides: [] })
    expect(single.slideCount).toBe(1)
    expect(readZip(single.buffer).has('ppt/slides/slide1.xml')).toBe(true)
  })
})
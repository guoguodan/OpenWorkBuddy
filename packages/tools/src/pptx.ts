import { deflateRawSync } from 'node:zlib'

/**
 * 零依赖 PPTX 生成。
 *
 * 只产出最小可用的 PresentationML:封面与要点页两种版式,不嵌入图片、
 * 不写宏、不引用外部关系。之所以不依赖 python-pptx 之类的本机工具,
 * 是因为技能脚本只能拿到白名单环境变量与固定解释器,用户机器装没装
 * Office/Python 不该决定"能不能出文件"。
 *
 * 产物可被 PowerPoint、Keynote、WPS 打开,也能被应用内预览解析
 * (预览只读 XML 部件,不依赖本模块)。
 */

export interface SlideBullet {
  text: string
  /** 二级要点:缩进一格,字号更小 */
  level?: 1 | 2
}

export interface SlideSpec {
  title: string
  bullets?: SlideBullet[]
}

export interface DeckSpec {
  title: string
  subtitle?: string
  slides: SlideSpec[]
}

export interface DeckResult {
  buffer: Buffer
  slideCount: number
}

export const SLIDE_WIDTH_EMU = 12_192_000 // 13.333in,16:9
export const SLIDE_HEIGHT_EMU = 6_858_000 // 7.5in

const TITLE_COLOR = '1F2329'
const MUTED_COLOR = '5B6570'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符会让 PowerPoint 直接判定文件损坏
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function textRun(text: string, size: number, bold: boolean, color: string): string {
  return (
    `<a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    '<a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/>' +
    `</a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`
  )
}

interface ParagraphStyle {
  size: number
  bold?: boolean
  color?: string
  align?: 'l' | 'ctr'
  /** 段后间距,单位 1/100 磅 */
  spaceAfter?: number
  bullet?: boolean
  /** 二级要点的左缩进,单位 EMU */
  indent?: number
}

function paragraph(text: string, style: ParagraphStyle): string {
  const align = style.align ? ` algn="${style.align}"` : ''
  const spaceAfter = style.spaceAfter
    ? `<a:spcAft><a:spcPts val="${style.spaceAfter}"/></a:spcAft>`
    : ''
  const indent = style.indent ? ` marL="${style.indent}" indent="-228600"` : ''
  const bullet = style.bullet ? '<a:buChar char="•"/>' : '<a:buNone/>'
  return (
    `<a:p><a:pPr${align}${indent}>${spaceAfter}${bullet}</a:pPr>` +
    textRun(text, style.size, style.bold ?? false, style.color ?? TITLE_COLOR) +
    '</a:p>'
  )
}

interface Box {
  x: number
  y: number
  cx: number
  cy: number
}

function textBox(id: number, name: string, box: Box, paragraphs: string[]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
    '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    paragraphs.join('') +
    '</p:txBody></p:sp>'
  )
}

function slideXml(shapes: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  )
}

function coverSlide(spec: DeckSpec, slide: SlideSpec): string {
  const shapes = [
    // 顶部色带,避免封面像一张空白文档
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${SLIDE_WIDTH_EMU}" cy="228600"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '<a:solidFill><a:srgbClr val="2FA36B"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>',
    textBox(3, 'Deck Title', { x: 838_200, y: 2_194_200, cx: 10_515_600, cy: 1_371_600 }, [
      paragraph(slide.title || spec.title, { size: 4400, bold: true })
    ]),
    ...(spec.subtitle
      ? [
          textBox(4, 'Deck Subtitle', { x: 838_200, y: 3_657_600, cx: 10_515_600, cy: 914_400 }, [
            paragraph(spec.subtitle, { size: 2000, color: MUTED_COLOR })
          ])
        ]
      : []),
    // 第一页同时也是内容页时,要点不能因为"套了封面版式"就被丢掉。
    ...(slide.bullets && slide.bullets.length > 0
      ? [
          textBox(
            5,
            'Cover Body',
            { x: 838_200, y: 4_572_000, cx: 10_515_600, cy: 1_600_200 },
            slide.bullets.slice(0, 6).map((bullet) =>
              paragraph(bullet.text, { size: 1600, color: MUTED_COLOR, spaceAfter: 600 })
            )
          )
        ]
      : [])
  ]
  return slideXml(shapes)
}

function bulletsSlide(slide: SlideSpec): string {
  const bullets = slide.bullets ?? []
  const body = bullets.length
    ? bullets.slice(0, 12).map((bullet) =>
        paragraph(bullet.text, {
          size: bullet.level === 2 ? 1600 : 1800,
          bullet: true,
          spaceAfter: 900,
          ...(bullet.level === 2 ? { indent: 457_200 } : {})
        })
      )
    : [paragraph('（这一页暂无要点）', { size: 1600, color: '8A94A0' })]
  return slideXml([
    textBox(2, 'Slide Title', { x: 838_200, y: 685_800, cx: 10_515_600, cy: 822_960 }, [
      paragraph(slide.title, { size: 2800, bold: true })
    ]),
    textBox(3, 'Slide Body', { x: 838_200, y: 1_828_800, cx: 10_515_600, cy: 4_114_800 }, body)
  ])
}

function relsXml(items: Array<{ id: string; type: string; target: string }>): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    items
      .map((item) => `<Relationship Id="${item.id}" Type="${item.type}" Target="${item.target}"/>`)
      .join('') +
    '</Relationships>'
  )
}

function contentTypesXml(slideCount: number): string {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ` +
      'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
  ).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slideOverrides +
    '</Types>'
  )
}

const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'

const THEME_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OpenWorkBuddy">' +
  '<a:themeElements><a:clrScheme name="OpenWorkBuddy">' +
  '<a:dk1><a:srgbClr val="1F2329"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="2FA36B"/></a:dk2><a:lt2><a:srgbClr val="F5F7F9"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="2FA36B"/></a:accent1><a:accent2><a:srgbClr val="5B6570"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="8A94A0"/></a:accent3><a:accent4><a:srgbClr val="C9D1D9"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="E8EDF2"/></a:accent5><a:accent6><a:srgbClr val="2F6FA3"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="2F6FA3"/></a:hlink><a:folHlink><a:srgbClr val="6B4FA3"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="OpenWorkBuddy">' +
  '<a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="OpenWorkBuddy">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>'

const SLIDE_MASTER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' +
  '<a:effectLst/></p:bgPr></p:bg>' +
  EMPTY_TREE +
  '</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2800" b="1">' +
  '<a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill>' +
  '</a:defRPr></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill>' +
  '</a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>'

const SLIDE_LAYOUT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  `<p:cSld name="Blank">${EMPTY_TREE}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

function presentationXml(slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`
  ).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle>' +
    '</p:presentation>'
  )
}

interface ZipEntry {
  name: string
  data: Buffer
}

let crcTable: Uint32Array | null = null

function crc32(input: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of input) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 固定时间戳与 deflate 级别,让相同输入产出逐字节一致的文件。 */
function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const compressed = deflateRawSync(raw, { level: 9 })
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // 文件名按 UTF-8 解码
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuffer, end])
}

/**
 * 生成演示文稿。
 *
 * 第一页就是封面:标题取 slides[0].title(为空时回落到 spec.title),副标题取
 * spec.subtitle,这一页的要点写在标题下方。这样页数与调用方给出的 slides 一致,
 * 不会因为"另外追加一页封面"把用户要的 10 页变成 11 页,也不会丢掉第一页内容。
 */
export function buildDeck(spec: DeckSpec): DeckResult {
  const slides: SlideSpec[] = spec.slides.length > 0 ? spec.slides : [{ title: spec.title }]
  const entries: ZipEntry[] = []
  const push = (name: string, data: string): void => {
    entries.push({ name, data: Buffer.from(data, 'utf8') })
  }

  push('[Content_Types].xml', contentTypesXml(slides.length))
  push(
    '_rels/.rels',
    relsXml([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
        target: 'ppt/presentation.xml'
      }
    ])
  )
  push('ppt/presentation.xml', presentationXml(slides.length))
  push(
    'ppt/_rels/presentation.xml.rels',
    relsXml([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
        target: 'slideMasters/slideMaster1.xml'
      },
      ...slides.map((_, index) => ({
        id: `rId${index + 2}`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
        target: `slides/slide${index + 1}.xml`
      })),
      {
        id: `rId${slides.length + 2}`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
        target: 'theme/theme1.xml'
      }
    ])
  )
  push('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER)
  push(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relsXml([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
        target: '../slideLayouts/slideLayout1.xml'
      },
      {
        id: 'rId2',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
        target: '../theme/theme1.xml'
      }
    ])
  )
  push('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT)
  push(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relsXml([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
        target: '../slideMasters/slideMaster1.xml'
      }
    ])
  )
  push('ppt/theme/theme1.xml', THEME_XML)

  slides.forEach((slide, index) => {
    const number = index + 1
    push(`ppt/slides/slide${number}.xml`, index === 0 ? coverSlide(spec, slide) : bulletsSlide(slide))
    push(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      relsXml([
        {
          id: 'rId1',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
          target: '../slideLayouts/slideLayout1.xml'
        }
      ])
    )
  })

  return { buffer: buildZip(entries), slideCount: slides.length }
}
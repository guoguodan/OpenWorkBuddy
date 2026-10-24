import { describe, expect, it } from 'vitest'
import {
  MAX_OFFICE_BYTES,
  ZipArchive,
  officeErrorDocument,
  parseXml,
  renderOfficeDocument
} from '../src/main/office-preview.js'

interface TestZipEntry {
  name: string
  data: Buffer
}

/** 生成测试用最小 ZIP:方法 0(仅存储),不压缩、不加密。 */
function buildZip(entries: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += 30 + name.length + entry.data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function entry(name: string, text: string): TestZipEntry {
  return { name, data: Buffer.from(text, 'utf8') }
}

function docx(body: string): Buffer {
  return buildZip([entry('word/document.xml', body)])
}

describe('Office 文档解析', () => {
  it('提取 Word 段落、标题、加粗与表格,并转义 HTML', () => {
    const file = docx(
      '<w:document xmlns:w="urn:test"><w:body>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>完成率 98%</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:tcPr><w:tblHeader/></w:tcPr><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>设备</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>'
    )

    const html = renderOfficeDocument(file, '.docx')
    expect(html).toContain('<h1>季度报告</h1>')
    expect(html).toContain('<strong>完成率 98%</strong>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('<th><p>项目</p></th>')
    expect(html).toContain('<td><p>设备</p></td>')
    expect(html).toContain('<td><p>120</p></td>')
  })

  it('提取 Excel 共享字符串、内联字符串与数值', () => {
    const file = buildZip([
      entry(
        'xl/workbook.xml',
        '<workbook xmlns:r="urn:r"><sheets><sheet name="汇总" sheetId="1" r:id="rId1"/></sheets></workbook>'
      ),
      entry(
        'xl/_rels/workbook.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
      ),
      entry(
        'xl/sharedStrings.xml',
        '<sst><si><t>名称</t></si><si><t>金额</t></si></sst>'
      ),
      entry(
        'xl/worksheets/sheet1.xml',
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>设备</t></is></c><c r="B2"><v>120</v></c></row>' +
          '</sheetData></worksheet>'
      )
    ])

    const html = renderOfficeDocument(file, '.xlsx')
    expect(html).toContain('<h2>汇总</h2>')
    expect(html).toContain('<th>名称</th>')
    expect(html).toContain('<td>设备</td>')
    expect(html).toContain('<td>120</td>')
  })

  it('提取 PPT 幻灯片顺序与文本', () => {
    const file = buildZip([
      entry(
        'ppt/presentation.xml',
        '<presentation xmlns:r="urn:r"><sldIdLst><sldId id="256" r:id="rId1"/></sldIdLst></presentation>'
      ),
      entry(
        'ppt/_rels/presentation.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'
      ),
      entry(
        'ppt/slides/slide1.xml',
        '<sld><cSld><spTree><sp><txBody><p><r><t>季度回顾</t></r></p></txBody></sp></spTree></cSld></sld>'
      )
    ])

    const html = renderOfficeDocument(file, '.pptx')
    expect(html).toContain('第 1 页')
    expect(html).toContain('季度回顾')
  })

  it('拒绝非 ZIP、越界条目、ZIP64 与 DTD 实体', () => {
    expect(() => renderOfficeDocument(Buffer.from('not a zip'), '.docx')).toThrow(/有效的 OOXML/)
    expect(() =>
      renderOfficeDocument(buildZip([entry('../evil.xml', '<x/>')]), '.docx')
    ).toThrow(/越界路径/)
    expect(() =>
      renderOfficeDocument(docx('<!DOCTYPE x [<!ENTITY y "z">]><w:document><w:body/></w:document>'), '.docx')
    ).toThrow(/XML 声明/)
    expect(() => renderOfficeDocument(Buffer.alloc(MAX_OFFICE_BYTES + 1), '.docx')).toThrow(/30MB/)
  })

  it('关闭脚本标签,并给出安全错误文档', () => {
    const parsed = parseXml('<root><item a="1">text</item></root>')
    expect(parsed.children[0]?.name).toBe('root')
    expect(new ZipArchive(buildZip([entry('a.xml', '<a/>')])).has('a.xml')).toBe(true)
    const error = officeErrorDocument('<img src=x onerror=alert(1)>')
    expect(error).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

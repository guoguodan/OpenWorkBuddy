import { Fragment, type ReactNode } from 'react'

/**
 * 轻量 Markdown 渲染:只覆盖模型回答里常见的语法(标题、列表、
 * 有序列表、引用、代码块、行内代码、粗体、斜体、链接)。
 * 不用 innerHTML,所有文本都以 React 文本节点输出,天然免疫 XSS。
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-i${i++}`

    if (token.startsWith('`')) {
      out.push(<code key={key} className="owb-md__code">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>)
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
    } else if (match[4] && match[5]) {
      const label = token.slice(1, token.indexOf(']'))
      out.push(
        <a key={key} href={match[5]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>
      )
    }
    last = pattern.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 代码块
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        body.push(lines[i] ?? '')
        i++
      }
      i++
      blocks.push(
        <pre key={`code-${i}`} className="owb-md__pre">
          {lang ? <span className="owb-md__pre-lang">{lang}</span> : null}
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const content = heading[2] ?? ''
      const Tag = (`h${Math.min(level + 2, 6)}`) as 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(<Tag key={`h-${i}`} className="owb-md__heading">{renderInline(content, `h-${i}`)}</Tag>)
      i++
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${i}`} className="owb-md__hr" />)
      i++
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={`q-${i}`} className="owb-md__quote">
          {renderInline(body.join('\n'), `q-${i}`)}
        </blockquote>
      )
      continue
    }

    // 表格:header 行 + 分隔行 + 数据行
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')
    ) {
      const splitRow = (row: string) =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) {
        rows.push(splitRow(lines[i] ?? ''))
        i++
      }
      blocks.push(
        <div key={`table-${i}`} className="owb-md__table-wrap">
          <table className="owb-md__table">
            <thead>
              <tr>
                {header.map((h, n) => <th key={n}>{renderInline(h, `th-${i}-${n}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn}>
                  {header.map((_, cn) => (
                    <td key={cn}>{renderInline(r[cn] ?? '', `td-${i}-${rn}-${cn}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={`ul-${i}`} className="owb-md__list">
          {items.map((it, n) => <li key={n}>{renderInline(it, `ul-${i}-${n}`)}</li>)}
        </ul>
      )
      continue
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={`ol-${i}`} className="owb-md__list">
          {items.map((it, n) => <li key={n}>{renderInline(it, `ol-${i}-${n}`)}</li>)}
        </ol>
      )
      continue
    }

    // 空行
    if (line.trim() === '') {
      i++
      continue
    }

    // 段落:合并连续非空行
    const para: string[] = []
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^\s*([-*+]\s+|\d+[.)]\s+|#{1,4}\s+|>|```)/.test(lines[i] ?? '')
    ) {
      para.push(lines[i] ?? '')
      i++
    }
    blocks.push(
      <p key={`p-${i}`} className="owb-md__p">
        {para.map((p, n) => <Fragment key={n}>{n > 0 ? '\n' : null}{renderInline(p, `p-${i}-${n}`)}</Fragment>)}
      </p>
    )
  }

  return <div className="owb-md">{blocks}</div>
}
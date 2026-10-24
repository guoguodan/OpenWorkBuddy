import type Database from 'better-sqlite3'

export type SearchGroup = 'message' | 'artifact' | 'task' | 'project'

/** 只依赖同步查询能力,单测可以传内存库 */
export type RawQueryable = Database.Database

export interface SearchHit {
  group: SearchGroup
  id: string
  conversationId: string
  conversationTitle: string
  /** 项目命中的定位键;其它分组为 undefined */
  projectId?: string
  seq: number | null
  title: string
  snippet: string
  role?: string
  createdAt: string
  score: number
}

export interface SearchResult {
  query: string
  groups: Array<{ group: SearchGroup; total: number; items: SearchHit[] }>
}

const GROUP_LIMIT = 5

/** FTS5 的查询串必须自己构造:用户输入的引号/星号会变成语法错误 */
export function toMatchQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["'*:^(){}\[\]]/g, '').trim())
    .filter(Boolean)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"*`).join(' AND ')
}

function snippet(text: string, q: string): string {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx < 0) return text.slice(0, 120)
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + q.length + 80)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * 跨会话检索。消息走 FTS5(英文/数字靠词元,中文靠 LIKE 兜底),
 * 产物与任务标题用 LIKE —— 它们量小,不需要额外索引。
 */
export function search(
  raw: RawQueryable,
  query: string,
  workspaceId?: string
): SearchResult {
  const q = query.trim()
  if (q.length === 0) return { query: q, groups: [] }

  const messageItems = searchMessages(raw, q)
  const artifactItems = searchArtifacts(raw, q)
  const taskItems = searchTasks(raw, q)
  const projectItems = searchProjects(raw, q, workspaceId)

  return {
    query: q,
    groups: [
      { group: 'message', total: messageItems.total, items: messageItems.items },
      { group: 'artifact', total: artifactItems.total, items: artifactItems.items },
      { group: 'task', total: taskItems.total, items: taskItems.items },
      { group: 'project', total: projectItems.total, items: projectItems.items }
    ]
  }
}

function searchMessages(
  raw: RawQueryable,
  q: string
) {
  const match = toMatchQuery(q)
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const rows = (match
    ? raw
        .prepare(
          `SELECT m.id, m.conversation_id, m.seq, m.role, m.created_at,
                  json_extract(m.content_json, '$.text') AS text,
                  c.title AS conversation_title,
                  bm25(message_fts) AS score
           FROM message_fts f
           JOIN message m ON m.rowid = f.rowid
           JOIN conversation c ON c.id = m.conversation_id
           WHERE message_fts MATCH ?
           ORDER BY score
           LIMIT 50`
        )
        .all(match)
    : []) as Array<Record<string, unknown>>

  // 中文在 unicode61 下是整段词元,MATCH 命中不了;LIKE 兜底保证"产品设计"能搜到"产品设计师"
  const fallback = (raw
    .prepare(
      `SELECT m.id, m.conversation_id, m.seq, m.role, m.created_at,
              json_extract(m.content_json, '$.text') AS text,
              c.title AS conversation_title, 0 AS score
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE json_extract(m.content_json, '$.text') LIKE ? ESCAPE '\\'
       ORDER BY m.created_at DESC
       LIMIT 50`
    )
    .all(like) as Array<Record<string, unknown>>)

  const byId = new Map<string, Record<string, unknown>>()
  for (const row of [...rows, ...fallback]) if (!byId.has(String(row.id))) byId.set(String(row.id), row)
  const ordered = [...byId.values()].sort((a, b) => Number(a.score ?? 0) - Number(b.score ?? 0))
  const items = ordered.slice(0, GROUP_LIMIT).map((r) => hitFromMessage(r, q))
  return { total: ordered.length, items }
}

function hitFromMessage(r: Record<string, unknown>, q: string): SearchHit {
  const text = String(r.text ?? '')
  return {
    group: 'message',
    id: String(r.id),
    conversationId: String(r.conversation_id),
    conversationTitle: String(r.conversation_title ?? ''),
    seq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
    title: String(r.conversation_title ?? ''),
    snippet: snippet(text, q),
    role: String(r.role ?? ''),
    createdAt: String(r.created_at ?? ''),
    score: Number(r.score ?? 0)
  }
}

function searchArtifacts(
  raw: RawQueryable,
  q: string
) {
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const rows = raw
    .prepare(
      `SELECT a.id, a.conversation_id, a.kind, a.title, a.path, a.created_at,
              c.title AS conversation_title
       FROM artifact a
       LEFT JOIN conversation c ON c.id = a.conversation_id
       WHERE a.title LIKE ? ESCAPE '\\' OR a.path LIKE ? ESCAPE '\\'
       ORDER BY a.created_at DESC
       LIMIT 50`
    )
    .all(like, like) as Array<Record<string, unknown>>
  return {
    total: rows.length,
    items: rows.slice(0, GROUP_LIMIT).map((r) => ({
      group: 'artifact' as const,
      id: String(r.id),
      conversationId: String(r.conversation_id ?? ''),
      conversationTitle: String(r.conversation_title ?? ''),
      seq: null,
      title: String(r.title ?? ''),
      snippet: `${String(r.kind ?? '')} · ${String(r.path ?? '')}`,
      createdAt: String(r.created_at ?? ''),
      score: 0
    }))
  }
}

function searchTasks(
  raw: RawQueryable,
  q: string
) {
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const rows = raw
    .prepare(
      `SELECT t.id, t.conversation_id, t.title, t.status, t.created_at,
              c.title AS conversation_title
       FROM task t
       JOIN conversation c ON c.id = t.conversation_id
       WHERE t.title LIKE ? ESCAPE '\\'
       ORDER BY t.created_at DESC
       LIMIT 50`
    )
    .all(like) as Array<Record<string, unknown>>
  return {
    total: rows.length,
    items: rows.slice(0, GROUP_LIMIT).map((r) => ({
      group: 'task' as const,
      id: String(r.id),
      conversationId: String(r.conversation_id ?? ''),
      conversationTitle: String(r.conversation_title ?? ''),
      seq: null,
      title: String(r.title ?? ''),
      snippet: `${String(r.status ?? '')} · ${String(r.created_at ?? '')}`,
      createdAt: String(r.created_at ?? ''),
      score: 0
    }))
  }
}

/**
 * 项目命中:名称/描述/项目指令。
 * 项目属于工作区,调用方给了 workspaceId 时必须隔离,避免跨工作区泄漏。
 */
function searchProjects(
  raw: RawQueryable,
  q: string,
  workspaceId?: string
) {
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const where = workspaceId ? 'p.workspace_id = ? AND ' : ''
  const params = workspaceId ? [workspaceId, like, like, like] : [like, like, like]
  const rows = raw
    .prepare(
      `SELECT p.id, p.name, p.description, p.instructions, p.created_at, p.updated_at
       FROM project p
       WHERE ${where}(p.name LIKE ? ESCAPE '\\'
          OR p.description LIKE ? ESCAPE '\\'
          OR p.instructions LIKE ? ESCAPE '\\')
       ORDER BY p.updated_at DESC
       LIMIT 50`
    )
    .all(...params) as Array<Record<string, unknown>>
  return {
    total: rows.length,
    items: rows.slice(0, GROUP_LIMIT).map((r) => {
      const description = String(r.description ?? '')
      const instructions = String(r.instructions ?? '')
      return {
        group: 'project' as const,
        id: String(r.id),
        projectId: String(r.id),
        conversationId: '',
        conversationTitle: '',
        seq: null,
        title: String(r.name ?? ''),
        snippet: description ? snippet(description, q) : snippet(instructions, q),
        createdAt: String(r.created_at ?? ''),
        score: 0
      }
    })
  }
}

export const _internal = { toMatchQuery, snippet }

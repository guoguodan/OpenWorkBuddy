// 迁移的唯一事实来源(运行时用这份,避免打包后找不到 .sql 文件)。
// drizzle/0000_init.sql 是同一份 DDL 的可审阅副本,由 test/migrations.test.ts 保证两者一致。
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `-- P4 权威 DDL:与 IMPLEMENTATION §5.2 等价
CREATE TABLE workspace (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  root_path     TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);

CREATE TABLE conversation (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  mode_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),
  last_seq      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_conversation_ws ON conversation(workspace_id, updated_at DESC);

CREATE TABLE message (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content_json      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'done'
                    CHECK (status IN ('streaming','done','interrupted')),
  client_request_id TEXT,
  model             TEXT,
  token_in          INTEGER NOT NULL DEFAULT 0,
  token_out         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE UNIQUE INDEX idx_message_idem
  ON message(conversation_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX idx_message_conv ON message(conversation_id, seq);

CREATE TABLE task (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES task(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK (status IN ('pending','running','done','failed','interrupted','skipped')),
  phase           TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  input_hash      TEXT,
  result_ref      TEXT,
  error_code      TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX idx_task_conv ON task(conversation_id, status);
CREATE INDEX idx_task_parent ON task(parent_id);

CREATE TABLE artifact (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES task(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('file','html','url','image')),
  title       TEXT NOT NULL,
  path        TEXT,
  url         TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,
  preview_ref TEXT,
  created_at  TEXT NOT NULL,
  CHECK (path IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX idx_artifact_task ON artifact(task_id);

CREATE TABLE skill (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('builtin','user','project')),
  name         TEXT NOT NULL,
  version      TEXT,
  path         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL,
  UNIQUE (scope, name)
);

CREATE TABLE plugin (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('connector','expert','mcp')),
  name             TEXT NOT NULL,
  version          TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  manifest_json    TEXT NOT NULL,
  installed_at     TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE automation (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  schedule_type  TEXT NOT NULL CHECK (schedule_type IN ('once','rrule')),
  rrule          TEXT,
  scheduled_at   TEXT,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  valid_from     TEXT,
  valid_until    TEXT,
  prompt         TEXT NOT NULL,
  mode_id        TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,
  last_run_at    TEXT,
  last_status    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_automation_due ON automation(enabled, next_run_at);

CREATE TABLE approval_grant (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('once','session','always')),
  group_key  TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE UNIQUE INDEX idx_grant_group ON approval_grant(group_key);

CREATE TABLE memory_entry (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('cloud','user','workspace')),
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('fact','preference','summary','log')),
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_path  TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_memory_scope ON memory_entry(scope, workspace_id, created_at DESC);
CREATE UNIQUE INDEX idx_memory_hash ON memory_entry(scope, content_hash);

CREATE TABLE event_log (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

-- 关键词召回:FTS5 外部内容表 + 同步触发器
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, content='memory_entry', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER memory_entry_ai AFTER INSERT ON memory_entry BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memory_entry_ad AFTER DELETE ON memory_entry BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memory_entry_au AFTER UPDATE ON memory_entry BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;` 
  },
  {
    version: 2,
    name: 'artifacts-and-message-fts',
    sql: `-- 交付物:会话归属与描述
ALTER TABLE artifact ADD COLUMN conversation_id TEXT REFERENCES conversation(id) ON DELETE CASCADE;
ALTER TABLE artifact ADD COLUMN description TEXT;
CREATE INDEX idx_artifact_conv ON artifact(conversation_id, created_at);

-- 回填已有产物的会话归属(经由任务)
UPDATE artifact
SET conversation_id = (SELECT conversation_id FROM task WHERE task.id = artifact.task_id)
WHERE conversation_id IS NULL AND task_id IS NOT NULL;

-- 全局搜索:消息正文的独立 FTS5 索引。
-- 用独立表而不是 external content,是因为正文在 content_json 里不是独立列。
CREATE VIRTUAL TABLE message_fts USING fts5(content, tokenize='unicode61');

INSERT INTO message_fts(rowid, content)
SELECT rowid, json_extract(content_json, '$.text')
FROM message
WHERE json_extract(content_json, '$.text') IS NOT NULL;

CREATE TRIGGER message_fts_ai AFTER INSERT ON message BEGIN
  INSERT INTO message_fts(rowid, content)
  VALUES (new.rowid, coalesce(json_extract(new.content_json, '$.text'), ''));
END;
CREATE TRIGGER message_fts_ad AFTER DELETE ON message BEGIN
  DELETE FROM message_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER message_fts_au AFTER UPDATE OF content_json ON message BEGIN
  DELETE FROM message_fts WHERE rowid = old.rowid;
  INSERT INTO message_fts(rowid, content) VALUES (new.rowid, coalesce(json_extract(new.content_json, '$.text'), ''));
END;`
  }
]

export const TARGET_VERSION = MIGRATIONS.length

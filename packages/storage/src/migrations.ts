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
  },
  {
    version: 3,
    name: 'channels-and-pending-events',
    sql: `-- 本地频道:先有频道概念,云侧推送与成员管理后续再接
CREATE TABLE channel (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE INDEX idx_channel_ws ON channel(workspace_id, created_at);

-- 会话可归属一个频道;NULL 表示纯本地会话
ALTER TABLE conversation ADD COLUMN channel_id TEXT REFERENCES channel(id) ON DELETE SET NULL;
CREATE INDEX idx_conversation_channel ON conversation(channel_id, updated_at);

-- 频道内共享的交付物。共享是"引用",不复制文件:
-- 预览仍走 artifact 的 path/url,权限与大小校验在预览层复用。
CREATE TABLE channel_artifact (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  artifact_id  TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  shared_at    TEXT NOT NULL,
  UNIQUE (channel_id, artifact_id)
);
CREATE INDEX idx_channel_artifact ON channel_artifact(channel_id, shared_at);

-- 待发队列:eventId 由客户端生成(ULID),重发沿用同一个 ID,
-- 服务端据此去重;seq 保证按产生顺序重放。
CREATE TABLE pending_event (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversation(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('event','artifact')),
  payload_json    TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  UNIQUE (workspace_id, seq)
);
CREATE INDEX idx_pending_due ON pending_event(workspace_id, sent_at, next_attempt_at, seq);`
  },
  {
    version: 4,
    name: 'workspace-settings-and-colleagues',
    sql: `-- 工作区级偏好:权限档位、默认任务运行位置、模型选择。
-- 单行表(key/value)避免每加一个开关就要改 DDL。
CREATE TABLE workspace_setting (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- 助理档案。真实产品里助理是"可复用的角色 + 技能/连接器绑定 + 指令",
-- 这里保存定义;每个助理的会话仍走普通 conversation,不做影子表。
CREATE TABLE colleague (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  instructions  TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT 'assistant',
  skill_names   TEXT NOT NULL DEFAULT '[]',
  connector_names TEXT NOT NULL DEFAULT '[]',
  mode_id       TEXT NOT NULL DEFAULT 'craft',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_colleague_ws ON colleague(workspace_id, created_at);
`
  },
  {
    version: 5,
    name: 'notifications',
    sql: `-- 消息中心:跨会话的业务提醒。与 event_log 分开,后者是会话内事件流水。
CREATE TABLE notification (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  biz             TEXT NOT NULL CHECK (biz IN ('task','automation','approval','system')),
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  conversation_id TEXT REFERENCES conversation(id) ON DELETE SET NULL,
  action_kind     TEXT NOT NULL DEFAULT 'none'
                  CHECK (action_kind IN ('open-conversation','none')),
  is_read         INTEGER NOT NULL DEFAULT 0,
  is_pending      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_notification_ws ON notification(workspace_id, created_at DESC);
CREATE INDEX idx_notification_pending ON notification(workspace_id, is_pending, is_read);
`
  },
  {
    version: 6,
    name: 'conversation_pin_and_colleague',
    sql: `-- 任务列表分组:置顶独立成组,助理任务按 colleague 归属分组。
-- pinned_at 用时间戳而不是布尔值,便于以后实现置顶排序时直接按时间排。
ALTER TABLE conversation ADD COLUMN colleague_id TEXT REFERENCES colleague(id) ON DELETE SET NULL;
ALTER TABLE conversation ADD COLUMN pinned_at TEXT;
CREATE INDEX idx_conversation_pinned ON conversation(workspace_id, pinned_at);
`
  },
  {
    version: 7,
    name: 'colleague_profile_and_availability',
    sql: `-- 助理完整档案:可用状态、可见范围、置顶、记忆开关与频道绑定。
-- 这些字段都直接参与运行时判定,不是纯展示:
--   paused        -> 新建会话/发送消息/定时任务都必须拒绝
--   skill_names   -> 收窄本轮可见技能与 load_skill 白名单
--   connector_names -> 收窄插件工具
--   channel_ids   -> 允许在哪些团队频道中被召唤
--   memory_enabled -> 关闭后本轮不再注入长期记忆
ALTER TABLE colleague ADD COLUMN channel_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE colleague ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','paused'));
ALTER TABLE colleague ADD COLUMN visibility TEXT NOT NULL DEFAULT 'personal'
  CHECK (visibility IN ('personal','project','public'));
ALTER TABLE colleague ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE colleague ADD COLUMN pinned_at TEXT;

DROP INDEX IF EXISTS idx_colleague_ws;
CREATE INDEX idx_colleague_ws ON colleague(workspace_id, pinned_at, created_at);
`
  },
  {
    version: 8,
    name: 'projects_connections_inspiration',
    sql: `-- 项目:独立协作实体。归属项目的任务通过 conversation.project_id 聚合,
-- 不是资料库的别名;项目指令/技能会进入运行链。
CREATE TABLE project (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  instructions  TEXT NOT NULL DEFAULT '',
  skill_names   TEXT NOT NULL DEFAULT '[]',
  pinned_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_project_ws ON project(workspace_id, pinned_at, updated_at);
ALTER TABLE conversation ADD COLUMN project_id TEXT REFERENCES project(id) ON DELETE SET NULL;
CREATE INDEX idx_conversation_project ON conversation(project_id, updated_at);

-- 外部服务连接:未探测成功前保持 not_connected,不得伪造成已连接。
CREATE TABLE service_connection (
  workspace_id    TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('mailbox','tencentDocs','ima','lexiang')),
  status          TEXT NOT NULL DEFAULT 'not_connected'
                  CHECK (status IN ('not_connected','connecting','connected','error')),
  endpoint        TEXT,
  account         TEXT,
  last_error      TEXT,
  last_checked_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

-- 灵感社区:本地信息流,与技能/资料库分离。
CREATE TABLE inspiration_post (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '本地',
  tags         TEXT NOT NULL DEFAULT '[]',
  favorite     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_inspiration_ws ON inspiration_post(workspace_id, created_at DESC);
`
  },
  {
    version: 9,
    name: 'conversation_pin_order',
    sql: `-- 置顶任务可拖拽排序。pin_order 只对置顶组生效,取消置顶时清空;
-- 新置顶的任务排到末尾,不会因为 pin_order 默认值挤到最前面。
ALTER TABLE conversation ADD COLUMN pin_order INTEGER;
DROP INDEX IF EXISTS idx_conversation_pinned;
CREATE INDEX idx_conversation_pinned ON conversation(workspace_id, pinned_at, pin_order);
`
  },
  {
    version: 10,
    name: 'conversation_expert',
    sql: `-- 每个任务最多绑定一个专家;专家是插件清单资产,删除插件后保留历史归属.
ALTER TABLE conversation ADD COLUMN expert_id TEXT;
`
  },
  {
    version: 11,
    name: 'conversation_custom_title',
    sql: `-- 自动标题与用户标题分开保存:用户手动改名后,custom_title 优先展示,
-- 后续轮次自动标题不得覆盖用户的选择.
ALTER TABLE conversation ADD COLUMN custom_title TEXT;
`
  },
  {
    version: 12,
    name: 'message_feedback',
    sql: `-- 消息级反馈:点赞/点踩绑定具体助手消息,刷新或重启后仍能恢复。
-- feedback_reason 单独存放,避免以后增加原因枚举时再改一次表结构;
-- 清除反馈时两列必须一起清空,不能让原因残留在未点踩的消息上。
ALTER TABLE message ADD COLUMN feedback TEXT
  CHECK (feedback IS NULL OR feedback IN ('like','dislike'));
ALTER TABLE message ADD COLUMN feedback_reason TEXT;
`
  },
  {
    version: 13,
    name: 'message_run_context_and_task_owner',
    sql: `-- 重放/回退需要两件事可追溯:
--   message.meta_json      本轮当时的模式/技能/场景/@文件,重放不能丢上下文
--   task.user_message_id   任务属于哪一轮,回退时按轮清理任务与交付物
-- 旧数据没有 meta_json/归属时不猜测,保留 NULL;回退对旧任务按时间不可靠,
-- 因此仅在能确定归属时删除任务,消息本身仍按 seq 精确截断。
ALTER TABLE message ADD COLUMN meta_json TEXT;
ALTER TABLE task ADD COLUMN user_message_id TEXT;
CREATE INDEX idx_task_user_message ON task(user_message_id);
`
  },
  {
    version: 14,
    name: 'file_checkpoint',
    sql: `-- 回退到此版本不仅要撤销会话,还要撤销这一轮对工作区文件的改动。
-- 清单快照只存路径与 sha256,内容按哈希去重存放在数据目录,避免每次复制整个工作区。
-- user_message_id 级联删除:消息被截断后,检查点不能残留成孤儿历史。
CREATE TABLE file_checkpoint (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  message_seq      INTEGER NOT NULL,
  before_json      TEXT NOT NULL,
  after_json       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_file_checkpoint_msg ON file_checkpoint(user_message_id);
CREATE INDEX idx_file_checkpoint_conv ON file_checkpoint(conversation_id, message_seq);
`
  },
  {
    version: 15,
    name: 'conversation_summary',
    sql: `-- 长对话压缩:把超出预算的最早若干轮压成一份摘要继续带进模型,
-- 而不是静默丢弃。covered_seq 记录摘要覆盖到哪条消息:
-- 回退/重放截断到该序号之前时,摘要必须作废,否则模型会基于不存在的历史回答。
-- 一个会话只有一份最新摘要,新摘要原子覆盖旧摘要。
CREATE TABLE conversation_summary (
  conversation_id   TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  covered_seq       INTEGER NOT NULL,
  covered_messages  INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL,
  source_chars      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_conversation_summary_seq ON conversation_summary(conversation_id, covered_seq);
`
  }
]

export const TARGET_VERSION = MIGRATIONS.length

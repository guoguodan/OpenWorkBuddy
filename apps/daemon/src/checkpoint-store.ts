import { resolve } from 'node:path'
import type { AppDatabase } from '@openwb/storage'
import {
  beginFileCheckpoint,
  finishFileCheckpoint,
  getFileCheckpointByMessage,
  listFileCheckpoints
} from '@openwb/storage'
import {
  changedPaths,
  parseManifest,
  restoreWorkspacePaths,
  snapshotWorkspace,
  type RestoreResult,
  type WorkspaceManifest
} from './checkpoints.js'

export interface CheckpointStoreOptions {
  db: AppDatabase
  workspaceRoot: string
  dataDir: string
}

export interface CheckpointApplyResult {
  applied: boolean
  reason?: string
  touched: number
  restored: number
  deleted: number
}

/**
 * 把 daemon 的检查点数据库行与磁盘快照串起来。
 * 恢复失败不会吞掉错误:调用方必须知道文件是否真的回到目标状态。
 */
export class CheckpointStore {
  private readonly blobDir: string

  constructor(private readonly options: CheckpointStoreOptions) {
    this.blobDir = resolve(options.dataDir, 'checkpoints', 'blobs')
  }

  async begin(input: { conversationId: string; userMessageId: string; messageSeq: number }): Promise<{
    id: string
    manifest: WorkspaceManifest
  }> {
    const manifest = await snapshotWorkspace(this.options.workspaceRoot, this.blobDir, {
      excluded: [resolve(this.options.dataDir)]
    })
    const id = beginFileCheckpoint(this.options.db, {
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      messageSeq: input.messageSeq,
      beforeJson: JSON.stringify(manifest)
    })
    return { id, manifest }
  }

  async finish(id: string): Promise<WorkspaceManifest> {
    const manifest = await snapshotWorkspace(this.options.workspaceRoot, this.blobDir, {
      excluded: [resolve(this.options.dataDir)]
    })
    finishFileCheckpoint(this.options.db, id, JSON.stringify(manifest))
    return manifest
  }

  /**
   * 把工作区恢复到 desired 描述的状态。
   *
   * turns 覆盖目标轮与被截断轮次;它们的改动路径取并集,只恢复这些路径。
   * 回退传目标轮 after,重放传目标轮 before。没有任何完整快照时不猜、不动磁盘。
   */
  async restore(
    desired: WorkspaceManifest | null,
    turns: Array<{ before: WorkspaceManifest; after: WorkspaceManifest | null }>
  ): Promise<CheckpointApplyResult> {
    if (!desired) {
      return { applied: false, reason: '该版本没有文件检查点', touched: 0, restored: 0, deleted: 0 }
    }
    if (!desired.complete) {
      return {
        applied: false,
        reason: `目标快照不完整${desired.reason ? `: ${desired.reason}` : ''}`,
        touched: 0,
        restored: 0,
        deleted: 0
      }
    }
    if (turns.length === 0) {
      return { applied: false, reason: '该版本没有文件检查点', touched: 0, restored: 0, deleted: 0 }
    }
    const touched = new Set<string>()
    for (const turn of turns) {
      if (!turn.before.complete || !turn.after?.complete) {
        return {
          applied: false,
          reason: '工作区快照不完整,未改动任何文件',
          touched: 0,
          restored: 0,
          deleted: 0
        }
      }
      for (const path of changedPaths(turn.before, turn.after)) touched.add(path)
    }
    if (touched.size === 0) {
      return { applied: true, touched: 0, restored: 0, deleted: 0 }
    }
    const result: RestoreResult = await restoreWorkspacePaths({
      root: this.options.workspaceRoot,
      blobDir: this.blobDir,
      manifest: desired,
      touched: [...touched]
    })
    return {
      applied: true,
      touched: result.touched,
      restored: result.restored,
      deleted: result.deleted
    }
  }

  byMessage(userMessageId: string) {
    const row = getFileCheckpointByMessage(this.options.db, userMessageId)
    if (!row) return null
    return {
      before: parseManifest(row.beforeJson),
      after: row.afterJson ? parseManifest(row.afterJson) : null
    }
  }

  afterSeq(conversationId: string, seq: number) {
    return listFileCheckpoints(this.options.db, conversationId)
      .filter((row) => row.messageSeq > seq)
      .map((row) => ({
        before: parseManifest(row.beforeJson),
        after: row.afterJson ? parseManifest(row.afterJson) : null
      }))
  }
}

export {}

interface ConversationInfo {
  id: string
  title: string
  modeId: string
  updatedAt: string
  lastSeq: number
}

interface MemoryItemInfo {
  id: string
  scope: string
  kind: string
  content: string
  tokens: number
  createdAt: string
}

interface HistoryMessage {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: unknown
  status: string
  tokenIn: number
  tokenOut: number
  createdAt: string
}

declare global {
  interface Window {
    openwb: {
      modes: {
        list: () => Promise<{ modes: Array<{ id: string; displayName: string; description: string }> }>
      }
      conversation: {
        send: (input: { text: string; mode?: string; conversationId?: string }) => Promise<void>
        list: () => Promise<{ conversations: ConversationInfo[]; conversationId: string }>
        history: (conversationId?: string) => Promise<{ messages: HistoryMessage[]; conversationId: string }>
        create: (input?: { title?: string; mode?: string }) => Promise<{ conversationId: string }>
        remove: (conversationId: string) => Promise<{ conversationId: string }>
        onEvent: (cb: (e: unknown) => void) => () => void
      }
      memory: {
        list: (scope?: string) => Promise<{ items: MemoryItemInfo[] }>
        remove: (id: string) => Promise<{ id: string }>
      }
    }
  }
}
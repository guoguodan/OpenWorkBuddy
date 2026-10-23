export {}

declare global {
  interface Window {
    openwb: {
      modes: {
        list: () => Promise<{ modes: Array<{ id: string; displayName: string; description: string }> }>
      }
      conversation: {
        send: (input: { text: string; mode?: string }) => Promise<void>
        onEvent: (cb: (e: unknown) => void) => () => void
      }
    }
  }
}
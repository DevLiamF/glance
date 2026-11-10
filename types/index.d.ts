export type GlanceStatusKind =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'question'
  | 'compacting'
  | 'interrupted'

export type GlanceStatus = { kind: GlanceStatusKind; detail?: string }

export type GlanceLimit = { percent: number; resetsAt?: string }

export type GlanceContext = { percent?: number; tokens?: number; window: number }

export type GlanceInfo = {
  /** What the session has cost so far, in US dollars. */
  costUsd?: number
  context?: GlanceContext
  model: string
  effort?: string
  cwd: string
  branch?: string
  isRepo: boolean
  fiveHour?: GlanceLimit
  week?: GlanceLimit
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    glance: {
      status: Shaped<GlanceStatus>
      info: Shaped<GlanceInfo | null>
      isHidden: boolean
    }
  }
}

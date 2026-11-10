import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { GlanceContext, GlanceInfo, GlanceLimit, GlanceStatus } from '../types'

// Change a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const status = atom(
  { plugin: 'glance', key: 'status' } as const,
  { kind: 'idle' } as GlanceStatus,
  { shape: 'status-1' },
)
const info = atom({ plugin: 'glance', key: 'info' } as const, null as GlanceInfo | null, {
  shape: 'info-1',
})
const isHidden = atom({ plugin: 'glance', key: 'isHidden' } as const, false)

const REFRESH_MS = 15_000
const BAR_CELLS = 12
const BAR_CELLS_MAX = 40
/** Inside width from which the card splits into two columns. */
const SPLIT_COLUMNS = 96
const DIVIDER = ' │ '

// ---------- formatting helpers ----------

/** "claude-opus-5-5[1m]" -> "Opus 5.5 (1M)"; anything else is shown as given. */
function prettyModel(raw: string): string {
  const isLong = /\[1m\]/i.test(raw)
  const id = raw.replace(/\[1m\]/i, '').trim()
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id)
  const family = m?.[1] ?? ''
  const name = m
    ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2] ?? ''}${m[3] ? `.${m[3]}` : ''}`
    : id
  return isLong ? `${name} (1M)` : name
}

function shortPath(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(home + '/'))) {
    return '~' + path.slice(home.length)
  }
  return path
}

/** Keeps the tail of a long path: "…/Claude/Mods/glance". */
function fitPath(path: string, room: number): string {
  if (path.length <= room) return path
  const parts = path.split('/')
  let out = parts[parts.length - 1] ?? ''
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + out
    if (next.length + 2 > room) break
    out = next
  }
  return '…/' + out
}

function bar(percent: number, cells: number): { full: string; empty: string } {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  // Thin line characters sit mid-row, which leaves space between stacked bars.
  return { full: '━'.repeat(filled), empty: '╌'.repeat(cells - filled) }
}

function limitColor(percent: number): string {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

function resetsIn(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return undefined
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const STATUS_LOOK: Record<GlanceStatus['kind'], { dot: string; label: string; color: string }> = {
  idle: { dot: '●', label: 'Idle', color: 'success' },
  thinking: { dot: '◐', label: 'Working', color: 'claude' },
  tool: { dot: '◐', label: 'Running', color: 'claude' },
  permission: { dot: '◆', label: 'Needs permission', color: 'permission' },
  question: { dot: '◆', label: 'Waiting for your answer', color: 'permission' },
  compacting: { dot: '◌', label: 'Compacting', color: 'warning' },
  interrupted: { dot: '■', label: 'Interrupted', color: 'error' },
}

// ---------- the working spinner ----------

// Claude Code's own spinner glyphs, played forward then back.
const SPIN_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
const SPIN_ORDER = [...SPIN_GLYPHS, ...SPIN_GLYPHS.slice(1, -1).reverse()]
const SPIN_MS = 120
const SPIN_KEY = 'glance-spinner'
/** Claude's orange as 0x00RRGGBB, and the terminal's own background. */
const CLAUDE_ORANGE = 0xd77757
const DEFAULT_BG = 0x01000000

/** One Raster cell, base64 of the u32 triplet [codePoint, fg, bg], little-endian. */
function cell(glyph: string): string {
  const words = Uint32Array.of(glyph.codePointAt(0) ?? 0x20, CLAUDE_ORANGE, DEFAULT_BG)
  const bytes = new Uint8Array(words.buffer)
  let raw = ''
  for (const b of bytes) raw += String.fromCharCode(b)
  return btoa(raw)
}
const SPIN_FRAMES = SPIN_ORDER.map(cell)

// The animation repaints the one cell in place, so the card is not redrawn
// each frame. A reload starts it over.
let spinTimer: Timer | undefined
let spinFrame = 0

function stopSpinner() {
  spinTimer?.cancel()
  spinTimer = undefined
}

// ---------- reading the session ----------

async function readBranch($: EngineInterface, cwd: string) {
  try {
    const head = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 3000 })
    if (head.exitCode !== 0) return { isRepo: false }
    const name = head.stdout.trim()
    if (name) return { isRepo: true, branch: name }
    // Detached HEAD: show the short commit instead.
    const sha = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 3000 })
    return { isRepo: true, branch: sha.exitCode === 0 ? `detached @ ${sha.stdout.trim()}` : 'no commits' }
  } catch {
    return { isRepo: false }
  }
}

function pickLimit(
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  kind: string,
): GlanceLimit | undefined {
  const one = limits.find(l => l.kind === kind)
  return one ? { percent: one.percentUsed, resetsAt: one.resetsAt } : undefined
}

function pickContext(context: { tokens?: number; window: number; percent?: number }): GlanceContext {
  return { percent: context.percent, tokens: context.tokens, window: context.window }
}

/** 68_412 -> "68k", 1_000_000 -> "1M". */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** 0.4231 -> "$0.42", 12.5 -> "$12.50", 1234.5 -> "$1,234.50". */
function usd(amount: number): string {
  const [whole = '0', cents = '00'] = amount.toFixed(2).split('.')
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}

async function initialEffort($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
  if (fromEnv && fromEnv !== 'auto' && fromEnv !== 'unset') return fromEnv
  const fromSettings = await $.settings.read({ key: 'effortLevel' })
  return typeof fromSettings === 'string' ? fromSettings : undefined
}

async function refresh($: EngineInterface, effort?: string) {
  const [model, cwd, usage, now] = await Promise.all([
    $.session.model(),
    $.session.cwd(),
    $.session.usage(),
    $.clock.now(),
  ])
  const git = await readBranch($, cwd)
  await update($, info, old => ({
    model,
    effort: effort ?? old?.effort,
    cwd,
    isRepo: git.isRepo,
    branch: git.branch,
    context: pickContext(usage.context),
    costUsd: usage.cost?.usd ?? old?.costUsd,
    fiveHour: pickLimit(usage.rateLimits, 'five_hour') ?? old?.fiveHour,
    week: pickLimit(usage.rateLimits, 'seven_day') ?? old?.week,
    now,
  }))
}

// ---------- the mod ----------

// Main-loop tool calls in flight, by tool_use_id. A reload starts it over.
const running = new Map<string, string>()
let isTurnRunning = false

/** Puts the status back to what is still going on: a tool, the turn, or idle. */
async function settle($: EngineInterface) {
  const last = [...running.values()].at(-1)
  const next: GlanceStatus = last
    ? { kind: 'tool', detail: last }
    : isTurnRunning
      ? { kind: 'thinking' }
      : { kind: 'idle' }
  await update($, status, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'glance',
      description: 'Show or hide the glance widget above the prompt',
    })
    await refresh($, await initialEffort($))
    $.clock.every(REFRESH_MS, () => void refresh($))
    return result
  })

  on('command.run', { command: 'glance' }, async $ => {
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? 'glance hidden. Run /glance to show it again.' : 'glance shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      running.clear()
      await update($, status, () => ({ kind: 'thinking' }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) {
      const effort = String(e.effort)
      const now = await read($, info)
      if (now?.effort !== effort) await update($, info, old => (old ? { ...old, effort } : old))
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurnRunning = false
    running.clear()
    await update($, status, () =>
      e.reason === 'aborted' ? { kind: 'interrupted' } : { kind: 'idle' },
    )
    void refresh($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const name = String(e.tool)
    running.set(e.tool_use_id, name)
    await update($, status, () =>
      name === 'AskUserQuestion' ? { kind: 'question' } : { kind: 'tool', detail: name },
    )
    try {
      return await next(e)
    } finally {
      running.delete(e.tool_use_id)
      await settle($)
      // A Bash call may have switched branches or directories.
      if (name === 'Bash') void refresh($)
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const waiting: GlanceStatus = { kind: 'permission', detail: e.tool_name }
    await update($, status, () => waiting)
    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    await update($, status, () => ({ kind: 'compacting' }))
    try {
      return await next(e)
    } finally {
      await settle($)
    }
  })

  on('session.measure', async ($, e, next) => {
    const isLimits = e.changed.includes('rateLimits')
    const isContext = e.changed.includes('context')
    const isCost = e.changed.includes('cost')
    if (isLimits || isContext || isCost) {
      const now = await $.clock.now()
      await update($, info, old =>
        old
          ? {
              ...old,
              context: isContext ? pickContext(e.context) : old.context,
              costUsd: isCost ? (e.cost?.usd ?? old.costUsd) : old.costUsd,
              fiveHour: isLimits ? (pickLimit(e.rateLimits, 'five_hour') ?? old.fiveHour) : old.fiveHour,
              week: isLimits ? (pickLimit(e.rateLimits, 'seven_day') ?? old.week) : old.week,
              now,
            }
          : old,
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, info)
    if (e.props.hasSurvey || data === null || (await read($, isHidden))) {
      stopSpinner()
      return next(e)
    }
    const st = await read($, status)

    const { Box, Text } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    const home = await $.env.get('HOME')

    // The card spans the band. Wide enough, it splits in two: the session on
    // the left, the bars on the right; narrower, it stacks as one column.
    const inner = Math.max(20, e.props.bodyColumns - 4) // border + padding
    const isSplit = inner >= SPLIT_COLUMNS
    const leftWidth = isSplit ? Math.floor((inner - DIVIDER.length) / 2) : inner
    const rightWidth = isSplit ? inner - DIVIDER.length - leftWidth : inner
    // The bars grow into the room the label, percentage and detail leave.
    const cells = Math.max(BAR_CELLS, Math.min(BAR_CELLS_MAX, rightWidth - 24))

    const look = STATUS_LOOK[st.kind]
    // Only the terminal draws a Raster; other surfaces keep the still dot.
    const isSpinning = (st.kind === 'thinking' || st.kind === 'tool') && e.surface === 'terminal'
    if (isSpinning && spinTimer === undefined) {
      const requestId = e.requestId
      spinTimer = $.clock.every(SPIN_MS, () => {
        spinFrame = (spinFrame + 1) % SPIN_FRAMES.length
        void $.ui.blit({ requestId, key: SPIN_KEY, cells: SPIN_FRAMES[spinFrame] ?? '' })
      })
    } else if (!isSpinning) {
      stopSpinner()
    }
    const label = st.detail ? `${look.label} ${st.detail}` : look.label
    const model = prettyModel(data.model)
    const branch = data.isRepo ? (data.branch ?? '') : 'no git'
    const dir = fitPath(shortPath(data.cwd, home), Math.max(8, leftWidth - branch.length - 4))

    /** One line: what is on the left, and what is on the right edge. */
    const line = (width: number, left: RenderChildren, right?: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Box flexShrink={1}>{left}</Box>
        {right !== undefined && <Box flexShrink={0} marginLeft={1}>{right}</Box>}
      </Box>
    )

    const meter = (name: string, percent: number | undefined, detail: string | undefined) => {
      if (percent === undefined) {
        return line(
          rightWidth,
          <Text>
            <Text dimColor>{name} </Text>
            <Text dimColor>{'·'.repeat(cells)}</Text>
          </Text>,
          <Text dimColor>no data yet</Text>,
        )
      }
      const b = bar(percent, cells)
      return line(
        rightWidth,
        <Text>
          <Text dimColor>{name} </Text>
          <Text color={limitColor(percent)}>{b.full}</Text>
          <Text dimColor>{b.empty}</Text>
          <Text bold> {String(Math.round(percent)).padStart(3)}%</Text>
        </Text>,
        detail !== undefined ? <Text dimColor>{detail}</Text> : undefined,
      )
    }

    const ctx = data.context
    const ctxDetail =
      ctx?.tokens !== undefined ? `${tokens(ctx.tokens)} / ${tokens(ctx.window)}` : undefined
    const resetDetail = (limit: GlanceLimit | undefined) => {
      const r = resetsIn(limit?.resetsAt, data.now)
      return r === undefined ? undefined : `↻ ${r}`
    }

    const icon =
      isSpinning && Raster !== undefined ? (
        <Raster key={SPIN_KEY} columns={1} rows={1} cells={SPIN_FRAMES[spinFrame] ?? ''} />
      ) : (
        <Text color={look.color}>{look.dot}</Text>
      )
    const statusText = (
      <Box flexDirection="row">
        {icon}
        <Text bold color={look.color} wrap="truncate-end">
          {' '}
          {label}
        </Text>
      </Box>
    )
    const costText =
      data.costUsd !== undefined ? (
        <Text>
          <Text dimColor>spent </Text>
          <Text bold>{usd(data.costUsd)}</Text>
        </Text>
      ) : undefined
    const modelText = (
      <Text>
        <Text color="claude">{model}</Text>
        {data.effort !== undefined && <Text dimColor> · {data.effort}</Text>}
      </Text>
    )
    const dirText = <Text wrap="truncate-start" dimColor>{dir}</Text>
    const branchText = (
      <Text>
        <Text dimColor>⎇ </Text>
        {data.isRepo ? <Text color="suggestion">{branch}</Text> : <Text dimColor>{branch}</Text>}
      </Text>
    )
    const bars = (
      <Box flexDirection="column">
        {meter('ctx ', ctx?.percent, ctxDetail)}
        {meter('5h  ', data.fiveHour?.percent, resetDetail(data.fiveHour))}
        {meter('week', data.week?.percent, resetDetail(data.week))}
      </Box>
    )

    if (isSplit) {
      return (
        <Box flexDirection="row" borderStyle="round" borderColor="claude" paddingX={1}>
          <Box flexDirection="column" width={leftWidth}>
            {line(leftWidth, statusText, costText)}
            {line(leftWidth, modelText)}
            {line(leftWidth, dirText, branchText)}
          </Box>
          <Box flexDirection="column">
            {[0, 1, 2].map(() => (
              <Text dimColor>{DIVIDER}</Text>
            ))}
          </Box>
          {bars}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        {line(inner, statusText, costText)}
        {line(inner, modelText)}
        {line(inner, dirText, branchText)}
        {/* One empty row between the session info and the bars. */}
        <Box marginTop={1}>{bars}</Box>
      </Box>
    )
  })
}

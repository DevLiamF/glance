import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'glance',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the band shows model, effort, branch, directory and limits', async ($, on) => {
  // Nothing sits beneath the plugin: these hooks stand for the engine.
  on('command.register', () => ({ value: { command: 'glance' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/Users/me/code/app' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 68_412, window: 200_000, percent: 34 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-11-10T15:00:00Z' },
        { kind: 'seven_day', percentUsed: 91 },
      ],
      cost: { usd: 1234.5 },
    },
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-10T12:30:00Z') }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))

  await $.session.start({ cwd: '/Users/me/code/app', surface: 'terminal', isInteractive: true })

  const layouts = [
    { surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen: true } },
    { surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen: false } },
    { surface: 'desktop', viewport: { columns: 120, rows: 40 } },
    // Narrow: the card stacks into one column.
    { surface: 'terminal', viewport: { columns: 64, rows: 40, isFullscreen: false } },
  ] as const
  for (const { surface, viewport } of layouts) {
    const props = { ...BAND.props, bodyColumns: viewport.columns - 5 }
    const ui = await $.ui.mount({ ...BAND, props, surface, viewport })
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /high/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~\/code\/app/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↻ 2h 30m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /91%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /34%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /68k \/ 200k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1,234\.50/ })).toBeDefined()
    await ui.unmount()
  }
})

test('after a tool call the status is idle with the still dot', async ($, on) => {
  on('command.register', () => ({ value: { command: 'glance' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/tmp/app' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('settings.read', () => ({ value: {} }))
  on('ui.blit', () => ({ value: {} }))
  on('clock.every', () => ({ value: undefined }))

  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/tmp/app', surface: 'terminal', isInteractive: true })
  const viewport = { columns: 120, rows: 40, isFullscreen: false }
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  // Once it is done the still dot is back.
  const after = await $.ui.mount({ ...BAND, surface: 'terminal', viewport })
  expect(await after.find({ key: 'glance-spinner' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Idle/ })).toBeDefined()
  await after.unmount()
})

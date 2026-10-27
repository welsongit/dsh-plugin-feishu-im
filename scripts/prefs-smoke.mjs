// The settings page persists its toggles through POST /api/feishu-im/prefs.
// A field the handler does not read is silently dropped while the response still
// answers 200, so the page keeps showing the old value — that is exactly how the
// default-permission buttons used to behave: they posted `defaultPermission`,
// nothing stored it, and the highlight snapped back on the next state read.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'feishu-prefs-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { readState } = await import('../lib/state.js')

/** Run the plugin with stub capabilities that record the routes it registers. */
const routes = new Map()
const ctx = {
  logger: { warn: () => {} },
  on: () => () => {},
  effect: (fn) => fn(),
  get: () => undefined,
  inject: (deps, callback) => {
    callback({
      effect: (fn) => fn(),
      tools: { register: () => () => {} },
      connection: {
        fetch: {
          register: (route) => {
            routes.set(route.path, route.fetch)
            return () => {}
          },
        },
      },
    })
  },
}

apply(ctx)

const prefs = routes.get('/api/feishu-im/prefs')
assert.equal(typeof prefs, 'function', 'prefs route is registered')

const post = (body) => prefs(new Request('http://localhost/api/feishu-im/prefs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

// Every permission mode the settings page offers must round-trip through state.
for (const mode of ['readonly', 'workspace', 'auto', 'full']) {
  const response = await post({ defaultPermission: mode })
  assert.equal(response.status, 200, `prefs accepts ${mode}`)
  assert.equal((await readState()).defaultPermission, mode, `${mode} is persisted`)
}

// An unknown mode is rejected instead of silently keeping the old value. The
// route wrapper turns a thrown error into a 400 carrying the message.
const rejected = await post({ defaultPermission: 'nonsense' })
assert.equal(rejected.status, 400, 'unknown mode is a 400, not a silent no-op')
assert.match((await rejected.json()).error, /未知的权限模式/)
assert.equal((await readState()).defaultPermission, 'full', 'a rejected save changes nothing')

// A Windows drive path is absolute and must be accepted; a bare relative name is
// not. The old check only understood `~` and `/`, so Windows operators could not
// point the folder at a real drive path at all.
await post({ sessionCwd: 'D:\\workspace\\feishu-im' })
assert.equal((await readState()).sessionCwd, 'D:\\workspace\\feishu-im', 'drive path is accepted')
await post({ sessionCwd: 'C:/workspace/feishu-im' })
assert.equal((await readState()).sessionCwd, 'C:/workspace/feishu-im', 'forward-slash drive path is accepted')
assert.equal((await post({ sessionCwd: 'relative/dir' })).status, 400, 'relative path is refused')
assert.equal((await post({ sessionCwd: '' })).status, 400, 'empty path is refused')

// The handler patches: an unrelated save must not reset an earlier choice.
await post({ notify: { turnEnd: false } })
const after = await readState()
assert.equal(after.notify.turnEnd, false, 'notify toggle is stored')
assert.equal(after.defaultPermission, 'full', 'an unrelated save does not reset the permission')

await rm(home, { recursive: true, force: true })
console.log('prefs smoke: all cases passed')

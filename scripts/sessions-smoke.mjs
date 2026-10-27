// Session listing/switching against a fake Host.
//
// Run: DSH_HOME=$(mktemp -d) node scripts/sessions-smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These cases write fixture state. Point DSH_HOME at a throwaway directory even
// when the caller forgot to, so a smoke test can never overwrite the operator's
// real Feishu credentials again (that happened on 2026-10-23).
if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'fsim-smoke-'))

const { createSessions } = await import('../lib/sessions.js')
const { readState, writeState } = await import('../lib/state.js')

const now = Date.now()
const summaries = [
  {
    sessionId: 'session-aaaa1111-2222-3333-4444-555566667777',
    updatedAt: now - 60_000,
    running: true,
    cwd: '/home/me/work/alpha',
    projections: { values: { title: '规划飞书插件' } },
  },
  {
    sessionId: 'session-bbbb8888-9999-0000-1111-222233334444',
    updatedAt: now - 3_600_000,
    running: false,
    cwd: '/home/me/work/beta',
    projections: { values: { title: '修 CI 流水线' } },
  },
  {
    // A subagent child must never appear in the picker.
    sessionId: 'session-ccccchild',
    updatedAt: now,
    running: false,
    parentSessionId: 'session-aaaa1111-2222-3333-4444-555566667777',
    cwd: '/home/me/work/alpha',
    projections: { values: { title: '子代理' } },
  },
]

// Workspace registry double: `create` reuses a record and keeps its title unless
// `setTitle` is called, exactly like the real service.
const created = []
const ctx = {
  get: (name) => {
    // Mirrors the live service: the list is wrapped, not a bare array.
    if (name === 'sessionController') return { list: async () => ({ items: summaries }) }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ path: '/home/me/work/alpha', title: '工作区 Alpha' }],
        create: async (path, title) => {
          created.push({ path, title })
          const existing = created.find((entry) => entry.path === path && entry.workspace)
          if (existing) return existing.workspace
          const workspace = {
            path,
            title: title || path.split('/').pop(),
            sessionIds: [],
            setTitle: async (next) => { workspace.title = next },
            attachSession: async (sessionId) => { workspace.sessionIds.push(sessionId) },
          }
          created[created.length - 1].workspace = workspace
          return workspace
        },
      }
    }
    return undefined
  },
}

await writeState({ appId: 'cli_test', appSecret: 'secret_test_value', domain: 'feishu', homeChatId: 'oc_test' })

const sessions = createSessions({ ctx, readState, writeState, trace: () => {} })

const rows = await sessions.list()
assert.equal(rows.length, 2, 'subagent children are filtered out')
assert.equal(rows[0].label, '规划飞书插件')
assert.equal(rows[0].workspace, '工作区 Alpha')
assert.equal(rows[1].label, '修 CI 流水线')

const filtered = await sessions.list({ query: 'ci' })
assert.equal(filtered.length, 1)
assert.equal(filtered[0].label, '修 CI 流水线')

const formatted = sessions.format(rows, rows[0].sessionId)
assert.match(formatted, /1\. \*\*规划飞书插件\*\* ←当前/)
assert.match(formatted, /2\. \*\*修 CI 流水线\*\*/)

// Indexes resolve against what the operator last saw.
sessions.remember('oc_test', rows)
assert.equal((await sessions.resolve('oc_test', '2')).sessionId, rows[1].sessionId)
assert.equal((await sessions.resolve('oc_test', 'session-bbbb')).sessionId, rows[1].sessionId)
assert.equal((await sessions.resolve('oc_test', 'CI')).sessionId, rows[1].sessionId)
assert.equal((await sessions.resolve('oc_test', rows[1].sessionId)).sessionId, rows[1].sessionId)
await assert.rejects(() => sessions.resolve('oc_test', 'nope'), /没找到匹配/)

await sessions.switchTo('oc_test', rows[1])
assert.equal(await sessions.current('oc_test'), rows[1].sessionId)
assert.equal((await sessions.chatOfSession(rows[1].sessionId)).chatId, 'oc_test')
assert.equal(await sessions.chatOfSession('session-unknown'), undefined)

const afterSwitch = sessions.format(rows, await sessions.current('oc_test'))
assert.match(afterSwitch, /2\. \*\*修 CI 流水线\*\* ←当前/, 'the current marker follows the binding')

// Workspace provisioning: created with the configured title, retitled when the
// setting changes, and a no-op when it already matches.
const first = await sessions.ensureWorkspace('/home/me/feishu', '飞书IM')
assert.equal(created.at(-1).path, '/home/me/feishu')
assert.equal(first.title, '飞书IM')
await sessions.ensureWorkspace('/home/me/feishu', '飞书 IM 工作区')
assert.equal(first.title, '飞书 IM 工作区')
const before = created.length
await sessions.ensureWorkspace('/home/me/feishu', '飞书 IM 工作区')
assert.equal(created.length, before + 1, 'still one registry call, but no redundant retitle')

// Sessions that already live in the folder are adopted into the workspace,
// which is what makes them show up inside the group in the UI.
summaries.push({ sessionId: 'session-feishuold', updatedAt: now, running: false, cwd: '/home/me/feishu', projections: { values: { title: '旧飞书会话' } } })
await sessions.ensureWorkspace('/home/me/feishu', '飞书IM')
assert.deepEqual(first.sessionIds, ['session-feishuold'], 'orphan session is attached to the workspace')
await sessions.ensureWorkspace('/home/me/feishu', '飞书IM')
assert.deepEqual(first.sessionIds, ['session-feishuold'], 'adoption is idempotent')

// Home expansion for the configured folder.
assert.equal(sessions.expandHome('~/dsh-plugin-feishu-im').endsWith('/dsh-plugin-feishu-im'), true)
assert.equal(sessions.expandHome('/abs/path'), '/abs/path')

// Windows has no HOME; the home directory lives in USERPROFILE. Expanding from
// an empty home used to collapse `~/x` into a root-relative `/x`, which Windows
// resolved to the drive root instead of the user's profile.
{
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  try {
    delete process.env.HOME
    process.env.USERPROFILE = 'C:\\Users\\me'
    assert.equal(sessions.expandHome('~/dsh-plugin-feishu-im'), 'C:\\Users\\me/dsh-plugin-feishu-im')
    assert.equal(sessions.expandHome('~'), 'C:\\Users\\me')
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }
}

console.log('sessions smoke: all cases passed')

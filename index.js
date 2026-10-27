/**
 * Host half of the Feishu IM plugin.
 *
 * Responsibilities in this phase:
 *   * own the durable connection state (a `0600` document, see lib/state.js);
 *   * drive the scan-to-create device-code flow, including the QR image;
 *   * verify and store manually entered credentials;
 *   * expose the settings page's HTTP surface as authenticated exact Fetch
 *     routes below `/api` (owner-peers only, no public listener);
 *   * send the one "connected" test message that proves the outbound path.
 *
 * Everything that reacts to harness work (notifications, approvals, inbound
 * commands) plugs into the same state object in the following phases.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  forgetTenantToken,
  getTenantToken,
  sendCard,
  sendMessage,
  updateCard,
  getBotInfo,
  listChats,
  pickTestTarget,
  normalizeDomain,
  registrationBegin,
  registrationInit,
  registrationPoll,
  sendText,
} from './lib/feishu.js'
import { createAnswerers } from './lib/answers.js'
import { createGateway } from './lib/gateway.js'
import { createCaptureStore } from './lib/captures.js'
import { createInbound } from './lib/inbound.js'
import { createSessions } from './lib/sessions.js'
import { createLabels } from './lib/labels.js'
import { createPermissions, PERMISSION_MODES } from './lib/permissions.js'
import { createRestart } from './lib/restart.js'
import * as service from './lib/service.js'
import { createNotifier } from './lib/notify.js'
import { qrSvgDataUrl } from './lib/qr.js'
import { clearState, publicState, readState, writeState } from './lib/state.js'

/** Route prefix on the shared API channel. `connection.fetch.register` validates
 *  the absolute path against the channel, so this must keep the `/api` prefix. */
const API = '/api/feishu-im'

/** A device-code registration stops being pollable after this long. */
const PENDING_TTL_MS = 15 * 60 * 1000

const PLUGIN_NAME = 'dsh-plugin-feishu-im'

/**
 * The tool registry validates raw JSON Schema, while the ergonomic definition
 * style marks required fields on each property. Fold `required: true` into the
 * object-level `required` array.
 */
/**
 * A provider rejects the whole request when one exposed tool schema is malformed,
 * so nothing is registered unless it survived normalization cleanly.
 */
function isSafeSchemaNode(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return true
  if (node.required !== undefined && !Array.isArray(node.required)) return false
  for (const [key, value] of Object.entries(node)) {
    if (value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      if (!value.every((item) => isSafeSchemaNode(item))) return false
      continue
    }
    if (key === 'properties' && (value === null || typeof value !== 'object' || Array.isArray(value))) return false
    if (!isSafeSchemaNode(value)) return false
  }
  return true
}

function isProviderSafeSchema(node) {
  return node !== null && typeof node === 'object' && node.type === 'object' && isSafeSchemaNode(node)
}

async function packageVersion() {
  try {
    const raw = await readFile(new URL('./package.json', import.meta.url), 'utf8')
    return JSON.parse(raw).version
  } catch {
    return '?'
  }
}

function normalizeToolSchema(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const copy = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue
    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {}
      const required = []
      for (const [name, child] of Object.entries(value)) {
        if (child && typeof child === 'object' && child.required === true) required.push(name)
        properties[name] = normalizeToolSchema(child)
      }
      copy.properties = properties
      if (required.length > 0) copy.required = required
      continue
    }
    if (key === 'items') {
      copy.items = normalizeToolSchema(value)
      continue
    }
    copy[key] = value
  }
  return copy
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function readJsonBody(request) {
  const text = await request.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法的 JSON')
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringList(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)
  const seen = new Set()
  const result = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * Opt-in activation trace (`DSH_FEISHU_IM_TRACE=1`).
 *
 * The Host process writes no log this plugin can read, so diagnosing a silent
 * failure — a route that was never registered, a long connection that never came
 * up — otherwise needs a debugger. Off by default; the file is
 * `$DSH_HOME/feishu-im/host-probe.log`.
 */
const TRACE_ENABLED = process.env.DSH_FEISHU_IM_TRACE === '1'

/** Sentinel that turns the trace on at runtime without restarting the Host. */
function traceFlagPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feishu-im', 'trace.on')
}

function probe(stage, detail) {
  if (!TRACE_ENABLED && !existsSync(traceFlagPath())) return
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    mkdirSync(join(home, 'feishu-im'), { recursive: true })
    appendFileSync(
      join(home, 'feishu-im', 'host-probe.log'),
      `${new Date().toISOString()} ${stage} ${JSON.stringify(detail ?? {})}\n`,
    )
  } catch {
    // Diagnostics must never affect activation.
  }
}

export function apply(ctx) {
  probe('apply-start', { node: process.version })

  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  /** id → pending device-code registration. */
  const pending = new Map()

  const prunePending = () => {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (now > entry.expiresAt) pending.delete(id)
    }
  }

  const requireConfigured = async () => {
    const state = await readState()
    if (!state.appId || !state.appSecret) throw new Error('还没有连接飞书应用，请先在设置页完成连接。')
    return state
  }

  const botIdentity = async (appId, appSecret, domain) => {
    const token = await getTenantToken(appId, appSecret, domain)
    const bot = await getBotInfo(token, domain)
    return { bot, token }
  }

  const handlers = {
    /** Full connection state for the page (secret-free). */
    async state() {
      prunePending()
      return json({ state: publicState(await readState()) })
    },

    /** Start scan-to-create and answer with the QR payload. */
    async onboardBegin(request) {
      const body = await readJsonBody(request)
      const domain = normalizeDomain(asString(body.domain) || 'feishu')
      await registrationInit(domain)
      const begin = await registrationBegin(domain)

      const id = randomUUID()
      const expiresAt = Date.now() + Math.min(begin.expireIn, PENDING_TTL_MS / 1000) * 1000
      pending.set(id, {
        deviceCode: begin.deviceCode,
        domain,
        interval: Math.max(2, begin.interval),
        expiresAt,
        lastPoll: 0,
      })
      prunePending()

      return json({
        id,
        domain,
        qrUrl: begin.qrUrl,
        qrDataUrl: await qrSvgDataUrl(begin.qrUrl),
        userCode: begin.userCode,
        expiresAt,
      })
    },

    /** Poll one registration; on success the credentials are already stored. */
    async onboardPoll(request) {
      const id = new URL(request.url).searchParams.get('id') || ''
      const entry = pending.get(id)
      if (!entry) return json({ status: 'unknown' })
      if (Date.now() > entry.expiresAt) {
        pending.delete(id)
        return json({ status: 'expired' })
      }
      const now = Date.now()
      if (now - entry.lastPoll < entry.interval * 1000) {
        return json({ status: 'pending', retryAfterMs: entry.interval * 1000 - (now - entry.lastPoll) })
      }
      entry.lastPoll = now

      let result
      try {
        result = await registrationPoll(entry.domain, entry.deviceCode)
      } catch (error) {
        return json({ status: 'pending', warning: error?.message || String(error) })
      }

      if (result.status === 'pending') return json({ status: 'pending' })
      pending.delete(id)
      if (result.status !== 'ready') return json({ status: result.status })

      let bot = { name: '', openId: '' }
      try {
        bot = (await botIdentity(result.appId, result.appSecret, result.domain)).bot
      } catch {
        // The credentials are valid enough to store; identity is best effort.
      }

      const previous = await readState()
      const saved = await writeState({
        ...previous,
        appId: result.appId,
        appSecret: result.appSecret,
        domain: result.domain,
        botName: bot.name,
        botOpenId: bot.openId,
        ownerOpenId: result.openId || previous.ownerOpenId,
        allowedOpenIds:
          previous.allowedOpenIds.length > 0
            ? previous.allowedOpenIds
            : result.openId
              ? [result.openId]
              : [],
        onboardedAt: Date.now(),
      })
      syncGateway()
      return json({ status: 'ready', state: publicState(saved) })
    },

    /** Stop waiting on a registration (the page closed the dialog). */
    async onboardCancel(request) {
      const body = await readJsonBody(request)
      const id = asString(body.id)
      if (id) pending.delete(id)
      return json({ ok: true })
    },

    /** Verify manually entered credentials, then store them. */
    async credentials(request) {
      const body = await readJsonBody(request)
      const appId = asString(body.appId)
      const appSecret = asString(body.appSecret)
      const domain = normalizeDomain(asString(body.domain) || 'feishu')

      if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error('App ID 应形如 cli_xxxxxxxx，请从飞书开放平台复制。')
      if (appSecret.length < 8) throw new Error('App Secret 看起来不完整。')

      const { bot } = await botIdentity(appId, appSecret, domain)
      const previous = await readState()
      if (previous.appId && previous.appId !== appId) forgetTenantToken(previous.appId, previous.domain)

      const saved = await writeState({
        ...previous,
        appId,
        appSecret,
        domain,
        botName: bot.name || previous.botName,
        botOpenId: bot.openId || previous.botOpenId,
      })
      syncGateway()
      return json({ state: publicState(saved) })
    },

    /** Persist the toggles and the allowlist. */
    async prefs(request) {
      const body = await readJsonBody(request)
      const previous = await readState()
      const next = { ...previous }

      if (body.notify && typeof body.notify === 'object') {
        next.notify = {
          turnEnd: body.notify.turnEnd !== false,
          approval: body.notify.approval !== false,
          question: body.notify.question !== false,
        }
      }
      if (body.allowedOpenIds !== undefined) next.allowedOpenIds = asStringList(body.allowedOpenIds)
      if (body.allowCommands !== undefined) next.allowCommands = body.allowCommands !== false
      if (body.answerMode !== undefined) next.answerMode = body.answerMode === 'both' ? 'both' : 'feishu'
      if (body.defaultPermission !== undefined) {
        const mode = asString(body.defaultPermission)
        if (!PERMISSION_MODES[mode]) throw new Error('未知的权限模式')
        next.defaultPermission = mode
      }
      if (body.sessionCwd !== undefined) {
        const cwd = asString(body.sessionCwd)
        if (!cwd) throw new Error('工作文件夹不能为空')
        // `~/…` is expanded later; otherwise require an absolute path. Windows
        // drive paths (`D:\…`, `D:/…`) are absolute too and must be accepted.
        const absolute = cwd.startsWith('~') || cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\/.test(cwd)
        if (!absolute) throw new Error('工作文件夹需要是绝对路径，或以 ~/ 开头')
        next.sessionCwd = cwd
      }
      if (body.workspaceTitle !== undefined) {
        const title = asString(body.workspaceTitle)
        if (!title) throw new Error('工作区名称不能为空')
        if (title.length > 60) throw new Error('工作区名称最长 60 个字符')
        next.workspaceTitle = title
      }
      if (body.answerTimeoutMinutes !== undefined) {
        const minutes = Number(body.answerTimeoutMinutes)
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120) throw new Error('等待上限需要是 0–120 之间的分钟数')
        next.answerTimeoutMinutes = Math.round(minutes)
      }
      if (body.awayMode !== undefined) next.awayMode = body.awayMode === true
      if (body.homeChatId !== undefined) next.homeChatId = asString(body.homeChatId)

      const saved = await writeState(next)
      answers.install(saved)
      return json({ state: publicState(saved) })
    },

    /** Re-verify the stored credentials and refresh the bot identity. */
    async verify() {
      const state = await requireConfigured()
      const { bot } = await botIdentity(state.appId, state.appSecret, state.domain)
      const saved = await writeState({
        ...state,
        botName: bot.name || state.botName,
        botOpenId: bot.openId || state.botOpenId,
        verifiedAt: Date.now(),
      })
      return json({ state: publicState(saved), bot })
    },

    /**
     * Send the one message that proves outbound delivery works.
     *
     * Manual credentials have no owner open_id until the operator messages the
     * bot, so fall back to the bound chat and then to a chat the bot is already
     * in instead of failing with "还没有可用的 open_id".
     */
    async test() {
      const state = await requireConfigured()
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      const chats = await listChats(token, state.domain).catch(() => [])
      const target = pickTestTarget(state, chats)
      if (!target) {
        throw new Error(
          '还没有可用的对话或用户：先在飞书里给机器人发一条消息（会自动记录成接收方），或重新扫码授权。',
        )
      }
      trace('test-target', { source: target.source })
      const sent = await sendText(token, state.domain, {
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        text: '✅ DSH 飞书 IM 已连接。\n之后任务完成、需要授权、需要你回答时，都会发到这个对话。',
      })
      return json({ ok: true, messageId: sent.messageId, target: target.source })
    },

    /** Drop the connection. */
    async disconnect() {
      const state = await readState()
      if (state.appId) forgetTenantToken(state.appId, state.domain)
      pending.clear()
      const cleared = await clearState()
      syncGateway()
      return json({ state: publicState(cleared) })
    },
  }

  const routes = [
    { path: `${API}/state`, methods: ['GET'], handler: handlers.state },
    { path: `${API}/onboarding/begin`, methods: ['POST'], handler: handlers.onboardBegin },
    { path: `${API}/onboarding/poll`, methods: ['GET'], handler: handlers.onboardPoll },
    { path: `${API}/onboarding/cancel`, methods: ['POST'], handler: handlers.onboardCancel },
    { path: `${API}/credentials`, methods: ['POST'], handler: handlers.credentials },
    { path: `${API}/prefs`, methods: ['POST'], handler: handlers.prefs },
    { path: `${API}/verify`, methods: ['POST'], handler: handlers.verify },
    { path: `${API}/test`, methods: ['POST'], handler: handlers.test },
    { path: `${API}/disconnect`, methods: ['POST'], handler: handlers.disconnect },
    {
      path: `${API}/service`,
      methods: ['GET', 'POST'],
      // `service.status()` is async: serializing the promise produced `{}`, which
      // the settings page rendered as "not a service" on a systemd host.
      handler: async (request) => (request.method === 'GET' ? json(await service.status()) : handlers.serviceAction(request)),
    },
  ]

  ctx.effect(() => () => pending.clear(), `${PLUGIN_NAME}: pending registrations`)

  /*
   * Rootless service management. A *user* systemd unit needs no sudo, which is
   * the only workable answer when the operator reaches this machine through the
   * web UI / Feishu and has no terminal to type a password into.
   */
  handlers.serviceAction = async (request) => {
    const body = (await request.json().catch(() => ({}))) || {}
    const action = String(body.action || '')
    if (action === 'restart-now') {
      return json(await restart.request({ sessionId: body.sessionId, reason: '设置页重启' }))
    }
    if (action === 'install') return json(await service.install({ cwd: process.cwd() }))
    if (action === 'remove') return json(await service.remove())
    if (action === 'restart') return json(await service.restart())
    if (action === 'status') return json(await service.status())
    throw new Error(`unknown action: ${action}`)
  }

  const trace = (stage, detail) => probe(stage, detail)
  /** Workspace + session names for every outward message. */
  const describe = createLabels(ctx)
  const captures = createCaptureStore()
  const sessions = createSessions({ ctx, readState, writeState, trace })
  const permissions = createPermissions({ ctx, readState, writeState, trace })
  /** chatId → the permission picker card's message id */
  const permissionCards = new Map()
  const answers = createAnswerers({
    permissions,
    permissionCards,
    captures,
    ctx,
    onResume: (chatId, row) => sessions.switchTo(chatId, row),
    readState,
    log: warn,
    trace,
    sendCard,
    describe,
    isAllowed: async (openId) => {
      const state = await readState()
      return openId === state.ownerOpenId || state.allowedOpenIds.includes(openId)
    },
  })
  const restart = createRestart({ ctx, readState, trace, log: warn })
  const inbound = createInbound({
    ctx,
    readState,
    writeState,
    log: warn,
    trace,
    captures,
    sessions,
    restart,
    permissions,
    permissionCards,
    onTextAnswer: (chatId, text) => answers.submitText(chatId, text),
    updateCardMessage: async (messageId, card) => {
      const state = await readState()
      return updateCard(state, messageId, card)
    },
    postCard: async (chatId, card) => {
      const state = await readState()
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      return sendMessage(token, state.domain, {
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'interactive',
        content: card,
      })
    },
  })
  const gateway = createGateway({ inbound, cardAction: (data) => answers.handleCardAction(data), log: warn, trace })
  const notifier = createNotifier({
    readState,
    log: warn,
    trace,
    describe,
    takeReply: inbound.takeReply,
    takeTyping: inbound.takeTyping,
  })
  // Registered directly: a fiber-scoped listener is disposed with this plugin on
  // unload, and `ctx.effect` would run it in a forked scope whose event lineage
  // does not necessarily include the sessions being observed.
  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event))

  /*
   * Enforce the chat's permission mode at the start of every turn.
   *
   * The agent registry lookup proved unreliable (it silently returned nothing
   * and the switch never reached the running session), but this hook is handed
   * the Session object itself — enough to append the durable `sandbox/mode`
   * event. The approval policy is re-asserted when an agent is reachable.
   */
  ctx.on('session/event', (session, event) => {
    // `step/start` matters too: a mode switched mid-turn should reach the next
    // tool call instead of waiting for the next user message.
    if (event?.type !== 'turn/start' && event?.type !== 'step/start') return
    void (async () => {
      try {
        const state = await readState()
        const chatId = Object.entries(state.chatSessions || {}).find(([, id]) => id === session.id)?.[0]
        if (!chatId) return
        const mode = permissions.modeOf(state, chatId)
        const spec = PERMISSION_MODES[mode]
        if (mode === 'auto' && permissions.autoReviewAvailable()) {
          // The Auto review preset owns the knobs (full access + ask); writing
          // our own sandbox mode here would make `permissionPresets.current()`
          // drift off `auto` and switch the review gate off.
          if (!permissions.autoReviewed(session)) {
            try {
              ctx.get('permissionPresets').set(session, 'auto')
              trace?.('permission-auto-preset-turn', {})
            } catch (error) {
              trace?.('permission-auto-preset-turn-failed', { message: String(error?.message || error) })
            }
          }
          return
        }
        const effective = ctx.get?.('sandboxPolicy')?.resolve?.({ session })?.mode
        if (effective !== spec.sandbox) {
          session.append('sandbox/mode', { mode: spec.sandbox })
          trace?.('permission-session-applied', { mode, sandbox: spec.sandbox, from: effective })
        }
        const agent = ctx.get?.('agents')?.get?.(session.id)
        if (agent) {
          trace?.('permission-agent-found', { hasSession: Boolean(agent.session) })
          try {
            ctx.get('approval')?.setPolicy?.(agent, spec.approval)
          } catch (error) {
            trace?.('permission-approval-failed', { message: String(error?.message || error) })
          }
        } else {
          trace?.('permission-agent-missing', { session: String(session.id).slice(0, 12) })
        }
      } catch (error) {
        trace?.('permission-turn-hook-failed', { message: String(error?.message || error) })
      }
    })()
  })

  /*
   * A restart started by scripts/restart-dsh.py kills the whole systemd cgroup,
   * so the script cannot report its own success. It leaves a marker instead and
   * the fresh process (this one) delivers the "back up" message.
   */
  const restartMarker = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-im', 'restart.pending')
  void (async () => {
    try {
      const raw = await readFile(restartMarker, 'utf8')
      await rm(restartMarker, { force: true })
      const marker = JSON.parse(raw)
      const age = Date.now() - (marker.requestedAt || 0)
      if (!(age >= 0 && age < 10 * 60_000)) {
        trace?.('restart-notice-stale', { age })
        return
      }
      const state = await readState()
      if (!state.appId || !state.appSecret) return
      const chatId = state.homeChatId || Object.keys(state.chatSessions || {})[0]
      if (!chatId) return
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      const version = await packageVersion()
      const seconds = Math.max(1, Math.round(age / 1000))
      await sendText(token, state.domain, {
        receiveId: chatId,
        receiveIdType: 'chat_id',
        text: `✅ DSH 已重启完成（插件 v${version}，约 ${seconds} 秒），刷新页面即可继续。`,
      })
      trace?.('restart-notice-sent', { version })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        trace?.('restart-notice-failed', { message: String(error?.message || error) })
        warn('restart notice failed:', error)
      }
    }
  })()
  probe('listener-registered', { event: 'session/event' })
  ctx.effect(() => () => {
    answers.uninstall()
    void gateway.stop()
  }, `${PLUGIN_NAME}: long connection`)
  const syncGateway = () => {
    void readState()
      .then((state) => {
        answers.install(state)
        return gateway.ensure(state)
      })
      .catch(() => {})
  }
  // The first connection attempt runs after activation settles, so a failing
  // WebSocket cannot fail the plugin's own load.
  setTimeout(syncGateway, 0)


  ctx.inject(['tools'], (scope) => {
    if (typeof scope.tools?.register !== 'function') return
    try {
      const definition = {
        name: 'feishu_sessions',
        description: [
          'List or switch the DSH session bound to this Feishu chat.',
          'Use it when the user asks which conversations exist, or wants to continue in another one.',
          'Switching takes effect for the NEXT message; the current turn stays in the current session.',
        ].join(' '),
        // A full JSON Schema: this registry hands `parameters` to the model as-is,
        // so a bare property map would arrive without `type: "object"` and the
        // provider would reject the whole request.
        parameters: normalizeToolSchema({
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              required: true,
              enum: ['list', 'current', 'switch'],
              description: 'list (with optional query) / current / switch (needs ref)',
            },
            query: { type: 'string', description: 'Case-insensitive filter for action=list.' },
            ref: {
              type: 'string',
              description: 'For action=switch: the 1-based number from the last list, a session id/prefix, or a title fragment.',
            },
          },
        }),
        output: {
          schema: normalizeToolSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              message: { type: 'string', required: true },
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'number', required: true },
                    label: { type: 'string', required: true },
                    sessionId: { type: 'string', required: true },
                    running: { type: 'boolean', required: true },
                  },
                },
              },
            },
          }),
          // The model-facing projection: one text block is enough for a picker.
          render: (_args, value) => [{ type: 'text', text: String(value?.message || '') }],
        },
        execute: async (args, exec) => {
          const action = String(args?.action || 'list')
          const sessionId = String(exec?.agent?.session?.id || exec?.agent?.id || '')
          const bound = sessionId ? await sessions.chatOfSession(sessionId) : undefined
          if (!bound) {
            return { message: '这个会话没有绑定飞书对话，只能在飞书发起的会话里用。' }
          }
          if (action === 'current') {
            const currentId = await sessions.current(bound.chatId)
            if (!currentId) return { message: '这个对话还没有绑定会话。' }
            const rows = await sessions.list({ limit: 50 })
            const label = rows.find((entry) => entry.sessionId === currentId)?.label || String(currentId)
            return { message: `当前绑定：${label}` }
          }
          if (action === 'switch') {
            const row = await sessions.resolve(bound.chatId, String(args?.ref || ''))
            await sessions.switchTo(bound.chatId, row)
            return { message: `已切换到「${row.label}」；下一条消息会进这个会话。` }
          }
          const rows = await sessions.list({ query: String(args?.query || ''), limit: 10 })
          sessions.remember(bound.chatId, rows)
          return {
            message: sessions.format(rows, await sessions.current(bound.chatId)),
            sessions: rows.map((row, index) => ({
              index: index + 1,
              label: row.label,
              sessionId: row.sessionId,
              running: Boolean(row.running),
            })),
          }
        },
      }
      /*
       * Permission changes requested by the agent. The tool never switches the
       * mode itself: it posts a confirmation card and only applies the change
       * after an allowlisted operator taps 允许.
       */
      const permissionDefinition = {
        name: 'feishu_permission',
        description: [
          'Read or REQUEST a change of the DSH session permission mode for this Feishu chat.',
          'A request posts a card with all four modes; the operator picks one and then confirms on a second card.',
          'The mode never changes without that confirmation, and the call blocks until it happens.',
          'Modes: readonly (sandbox read-only), workspace (workspace read-write),',
          'auto (plugin reviews approvals in the workspace), full (danger-full-access, no prompts).',
        ].join(' '),
        parameters: normalizeToolSchema({
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              required: true,
              enum: ['current', 'request'],
              description: 'current reads the mode; request asks the operator to switch it (needs mode).',
            },
            mode: {
              type: 'string',
              enum: ['readonly', 'workspace', 'auto', 'full'],
              description: 'Suggested target for action=request; the operator still picks and confirms.',
            },
            reason: { type: 'string', description: 'Why the change is needed; shown on the confirmation card.' },
          },
        }),
        output: {
          schema: normalizeToolSchema({
            type: 'object',
            additionalProperties: false,
            properties: {
              message: { type: 'string', required: true },
              ok: { type: 'boolean' },
              mode: { type: 'string' },
              label: { type: 'string' },
              sandbox: { type: 'string' },
            },
          }),
          render: (result) => result?.message || '权限请求已处理',
        },
        execute: async (args, exec) => {
          try {
          const sessionId = String(exec?.agent?.session?.id || exec?.agent?.id || '')
          const bound = sessionId ? await sessions.chatOfSession(sessionId) : undefined
          if (!bound) return { message: '这个会话没有绑定飞书对话，只能在飞书发起的会话里用。', ok: false }
          const state = await readState()
          const mode = permissions.modeOf(state, bound.chatId)
          if (String(args?.action || 'current') === 'current') {
            return {
              message: `当前权限：${PERMISSION_MODES[mode].label}。${PERMISSION_MODES[mode].hint}`,
              ok: true,
              mode,
              label: PERMISSION_MODES[mode].label,
              sandbox: PERMISSION_MODES[mode].sandbox,
            }
          }
          const suggested = String(args?.mode || '')
          if (suggested && !PERMISSION_MODES[suggested]) {
            return { message: `未知的权限模式：${suggested}`, ok: false }
          }
          const reply = await answers.requestPermissionChange({
            chatId: bound.chatId,
            mode: suggested || undefined,
            reason: String(args?.reason || ''),
            label: PERMISSION_MODES[mode].label,
          })
          if (!reply.ok) return { message: reply.error, ok: false }
          const applied = PERMISSION_MODES[reply.mode]
          return {
            message: `已征得同意，权限切到「${applied.label}」：${applied.hint}`,
            ok: true,
            mode: reply.mode,
            label: applied.label,
            sandbox: applied.sandbox,
          }
          } catch (error) {
            probe('permission-tool-failed', { message: String((error && error.message) || error).slice(0, 160) })
            return { message: `权限操作失败：${String((error && error.message) || error)}`, ok: false }
          }
        },
      }
      if (!isProviderSafeSchema(permissionDefinition.parameters)) {
        throw new Error('feishu_permission parameters are not a provider-safe JSON Schema')
      }
      scope.effect(() => scope.tools.register(permissionDefinition), `${PLUGIN_NAME}: feishu_permission tool`)
      probe('tool-registered', { name: 'feishu_permission' })

      if (!isProviderSafeSchema(definition.parameters)) {
        throw new Error('feishu_sessions parameters are not a provider-safe JSON Schema')
      }
      if (!isProviderSafeSchema(definition.output.schema)) {
        throw new Error('feishu_sessions output schema is not a provider-safe JSON Schema')
      }
      scope.effect(() => scope.tools.register(definition), `${PLUGIN_NAME}: feishu_sessions tool`)
      probe('tool-registered', { name: 'feishu_sessions' })
    } catch (error) {
      probe('tool-failed', { message: String((error && error.message) || error) })
      warn(`[${PLUGIN_NAME}] feishu_sessions tool unavailable: ${(error && error.message) || error}`)
    }
  })

  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    probe('connection-available', {
      connection: typeof connection,
      register: typeof connection?.fetch?.register,
    })
    if (!connection || typeof connection.fetch?.register !== 'function') {
      warn(`[${PLUGIN_NAME}] connection.fetch is unavailable; the Feishu IM settings page cannot reach the host`)
      return
    }

    for (const route of routes) {
      try {
        scope.effect(
          () =>
            connection.fetch.register({
              path: route.path,
              methods: route.methods,
              requestBody: 'buffered',
              fetch: async (request) => {
                try {
                  return await route.handler(request)
                } catch (error) {
                  const message = error?.message || String(error)
                  warn(`[${PLUGIN_NAME}] ${request.method} ${route.path}: ${message}`)
                  return json({ error: message, ...(error?.hint ? { hint: error.hint } : {}) }, 400)
                }
              },
            }),
          `${PLUGIN_NAME}: ${route.path}`,
        )
        probe('route-registered', { path: route.path, methods: route.methods })
      } catch (error) {
        probe('route-failed', { path: route.path, message: String((error && error.message) || error) })
        warn(`[${PLUGIN_NAME}] cannot register ${route.path}: ${(error && error.message) || error}`)
      }
    }
  })
}

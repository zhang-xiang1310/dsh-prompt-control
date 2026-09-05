/**
 * DSH提示词 host half (deployment-persistent bundle plugin).
 *
 * Serves the JSON API the settings page calls:
 *   POST /dshp/api/state   -> { system, appended }
 *   POST /dshp/api/save    -> body { text }; empty/whitespace text = restore
 *   POST /dshp/api/restore -> clears the appended text
 *
 * The DSH system prompt is NOT overridden. While an appended text is stored, a
 * global NON-complete system-prompt section whose text is `{{dsh_prompt_suffix}}`
 * (resolved from a variable, so the stored text is inserted verbatim and never
 * re-scanned for `{{...}}`) is registered with a very high `order`. Because the
 * section carries no `complete` flag, the default dynamic sections (persona,
 * harness identity, tool descriptions, ...) are kept intact and the appended
 * text lands as the LAST section of every session's rendered system message.
 *
 * State (only the appended text) persists to
 * `$DSH_HOME/dsh-prompt-control.json`, so it survives restarts and is re-applied
 * when this plugin loads again.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const name = 'dsh-prompt-control'
const inject = ['systemPrompt', 'sessions', 'agents', 'webServer']

/** Registry names owned by this plugin (global layer). */
const SECTION_NAME = 'dsh-prompt:user-suffix'
const VARIABLE_NAME = 'dsh_prompt_suffix'
/**
 * Order high enough to sort after every first-party section
 * (the largest first-party placement is 9900), so the appended text is the
 * final section of the rendered system message.
 */
const SECTION_ORDER = 100000
/** Persisted state file, relative to the DSH home directory. */
const STATE_FILE = 'dsh-prompt-control.json'
// The webserver prefix-route contract forbids a trailing slash on `path`
// (a prefix `p` matches `p` and `p/<anything>`); registering '/dshp/api/' would
// only ever match '/dshp/api//...'. Keep the route base slash-less and match
// the '<method>' sub-path against a full '/dshp/api/' string below.
const API_PREFIX = '/dshp/api'
const API_MATCH = '/dshp/api/'
/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/* ------------------------------------------------------------------ *
 * Wire helpers (same conventions as every other /xxx/api bundle route).
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large', 400)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON', 400)
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

function requireTextField(payload) {
  const value = payload?.text
  if (typeof value !== 'string') throw new ApiError('bad-request', 'missing or invalid "text"')
  return value
}

/* ------------------------------------------------------------------ *
 * Request fence: loopback GUI only (this deployment serves 127.0.0.1).
 * ------------------------------------------------------------------ */

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function isTrustedApiRequest(request) {
  const host = request.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined || origin === '') return true
  try {
    return new URL(origin).hostname === hostname
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Persisted state + default-prompt discovery.
 * ------------------------------------------------------------------ */

function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.trim() !== '' ? env : join(homedir(), '.dsh')
}

function statePath() {
  return join(dshHome(), STATE_FILE)
}

function isEmptyPrompt(text) {
  return typeof text !== 'string' || text.trim() === ''
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'))
    // `appended` is the current shape; tolerate a legacy `override` field.
    const raw = parsed.appended ?? parsed.override
    return {
      appended: typeof raw === 'string' && raw.trim() !== '' ? raw : undefined,
    }
  } catch {
    return { appended: undefined }
  }
}

async function saveState(state) {
  const target = statePath()
  const tmp = `${target}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(tmp, JSON.stringify({ appended: state.appended ?? null }, null, 2), 'utf8')
  await rename(tmp, target)
}

/**
 * The system prompt a fresh model request would receive for the first live
 * agent, WITHOUT this plugin's appended suffix section (the top, read-only
 * region of the settings page). Prefers a live assembly over the scope of an
 * existing agent (authoritative), then falls back to the last recorded request
 * header of a live session, then undefined.
 */
async function readDefaultPrompt(ctx) {
  const agents = ctx.get?.('agents')
  const candidates = agents?.roots?.() ?? agents?.list?.() ?? []
  for (const agent of candidates) {
    const agentCtx = agent?.ctx
    if (agentCtx === undefined) continue
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: agentCtx })
      if (assembly !== undefined && Array.isArray(assembly.sections) && assembly.sections.length > 0) {
        // Drop our own suffix so the read-only region shows only the default
        // dynamic prompt, independent of whether an append is stored.
        const sections = assembly.sections.filter(section => section.name !== SECTION_NAME)
        const text = renderPrompt({ ...assembly, sections })
        if (text !== '') return text
      }
    } catch {
      // Fall through to the header-based probe below.
    }
  }
  const sessions = ctx.get?.('sessions')
  if (sessions !== undefined) {
    for (const session of sessions.list() ?? []) {
      try {
        const header = session.requestHeader?.()
        if (header !== undefined && typeof header.system === 'string' && header.system !== '') {
          return header.system
        }
      } catch {
        // Keep scanning.
      }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

function apply(ctx) {
  let state = { appended: undefined }
  let currentAppended = undefined
  let suffixDisposers = []

  const clearSuffixRegistrations = () => {
    for (const dispose of suffixDisposers) {
      try {
        dispose?.()
      } catch {
        // A disposer may already have run during teardown.
      }
    }
    suffixDisposers = []
  }

  /**
   * (Re)register the global non-complete suffix section + variable while an
   * appended text is set. Without `complete`, the default dynamic sections are
   * preserved and this text becomes the last section of the system message.
   */
  const syncSuffixRegistration = () => {
    clearSuffixRegistrations()
    if (isEmptyPrompt(currentAppended)) return
    const sectionDisposer = ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: `{{${VARIABLE_NAME}}}`,
    })
    const variableDisposer = ctx.systemPrompt.variable(VARIABLE_NAME, () => currentAppended ?? '')
    suffixDisposers = [sectionDisposer, variableDisposer]
  }

  const api = {
    async state() {
      const system = await readDefaultPrompt(ctx)
      return { system: system ?? '', appended: currentAppended ?? state.appended ?? '' }
    },

    async save(text) {
      if (isEmptyPrompt(text)) return this.restore()
      currentAppended = text
      state.appended = text
      syncSuffixRegistration()
      await saveState(state)
      const system = await readDefaultPrompt(ctx)
      return { system: system ?? '', appended: text }
    },

    async restore() {
      currentAppended = undefined
      state.appended = undefined
      clearSuffixRegistrations()
      await saveState(state)
      const system = await readDefaultPrompt(ctx)
      return { system: system ?? '', appended: '' }
    },
  }

  // Teardown: drop the global suffix registrations when this plugin unloads.
  ctx.effect(
    () => () => {
      clearSuffixRegistrations()
    },
    'dsh-prompt-control: teardown',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(API_MATCH)
            ? pathname.slice(API_MATCH.length)
            : undefined
          if (method === undefined || method === '' || method.includes('/')) {
            writeError(res, new ApiError('not-found', 'unknown DSH提示词 API method', 404))
            return
          }
          try {
            const payload = await readJsonBody(req)
            let value
            switch (method) {
              case 'state':
                value = await api.state()
                break
              case 'save':
                value = await api.save(requireTextField(payload))
                break
              case 'restore':
                value = await api.restore()
                break
              default:
                throw new ApiError('not-found', `unknown DSH提示词 API method "${method}"`, 404)
            }
            writeOk(res, value)
          } catch (error) {
            writeError(res, error)
          }
        },
      }),
    'dsh-prompt-control: /dshp/api routes',
  )

  // Apply the persisted append once this plugin mounts (loadState is async).
  loadState()
    .then((loaded) => {
      state = loaded
      currentAppended = loaded.appended
      syncSuffixRegistration()
    })
    .catch(() => {
      // Keep the plugin mounted with no append on an unreadable state file.
      state = { appended: undefined }
    })
}

export { apply, inject, name }

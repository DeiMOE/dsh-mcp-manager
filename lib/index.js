/**
 * dsh-mcp-manager — host half.
 *
 * An MCP management plugin for DSH web:
 *  - global enable/disable per MCP server and per tool (settings namespace
 *    `dsh-mcp-manager`, persisted in settings.yaml)
 *  - per-workspace three-state overrides (inherit / on / off) for servers and
 *    tools, stored in each workspace's `<workspace>/.dsh/mcp.yml` (workspace
 *    priority over global)
 *  - MCP server CRUD against the profile's cordis.patch.yml (surgical
 *    line edits that preserve every other byte of the file)
 *  - enforcement: for every live agent, the effective tool set is computed
 *    from the agent's session cwd (its workspace) and applied through
 *    `tools.restrict` on the agent's own scope, so disabled MCP tools are
 *    invisible to the model.
 *
 * The pure helpers at the bottom are exported for standalone testing.
 */
import z from 'schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { readFile, writeFile, mkdir, rm, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'

/** Debug log file (boot-time diagnostics when the UI is unavailable). */
const DEBUG_LOG = join(process.env.HOME || process.cwd(), '.dsh', 'mcp-manager-debug.log')
async function debugLog(msg) {
  try {
    await appendFile(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch (e) {
    /* never let logging break the plugin */
  }
}

/** Settings namespace holding the global server/tool switches. */
const NS = 'dsh-mcp-manager'
/** The loader row name every MCP server instance uses. */
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'
/** Public tool-name prefix produced by dsh-mcp-client. */
const MCP_PREFIX = 'mcp__'

/** Schemastery schema for the global config section. */
const GlobalSchema = z.object({
  servers: z.dict(z.object({
    enabled: z.boolean().default(true),
    tools: z.dict(z.boolean()).default({})
  })).default({})
})

/** Loader config: the workspace-relative config file path. */
const Config = z.object({
  workspaceFile: z.string().default('.dsh/mcp.yml')
})

const name = 'mcp-manager'

// ---------------------------------------------------------------------------
// Pure helpers (exported for standalone tests)
// ---------------------------------------------------------------------------

/**
 * Normalize any YAML-ish tri-state spelling to 'on' | 'off' | 'inherit'.
 * booleans are accepted for hand-edited friendliness.
 */
export function normalizeTriState(value, fallback = 'inherit') {
  if (value === true || value === 'on' || value === 'enabled' || value === 'true' || value === 1) return 'on'
  if (value === false || value === 'off' || value === 'disabled' || value === 'false' || value === 0) return 'off'
  return fallback
}

/** Normalize a parsed workspace file body into `{ servers: { name: { enabled, tools } } }`. */
export function normalizeWorkspaceFile(raw) {
  const servers = {}
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const rawServers = raw.servers !== null && typeof raw.servers === 'object' && !Array.isArray(raw.servers)
      ? raw.servers
      : {}
    for (const [srv, cfg] of Object.entries(rawServers)) {
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) continue
      const tools = {}
      if (cfg.tools !== null && typeof cfg.tools === 'object' && !Array.isArray(cfg.tools)) {
        for (const [tool, value] of Object.entries(cfg.tools)) tools[tool] = normalizeTriState(value)
      }
      servers[srv] = { enabled: normalizeTriState(cfg.enabled), tools }
    }
  }
  return { servers }
}

/** Drop 'inherit' entries so the file only stores explicit overrides. */
export function pruneWorkspaceFile(normalized) {
  const servers = {}
  for (const [srv, cfg] of Object.entries(normalized.servers ?? {})) {
    if (cfg.enabled !== 'inherit') {
      servers[srv] = { ...servers[srv], enabled: cfg.enabled }
    }
    const tools = {}
    for (const [tool, value] of Object.entries(cfg.tools ?? {})) {
      if (value !== 'inherit') tools[tool] = value
    }
    if (Object.keys(tools).length > 0) servers[srv] = { ...servers[srv], tools }
  }
  return { servers }
}

/**
 * Compute the effective deny list (public tool names to hide) for one
 * workspace from the global config, workspace overrides and the live
 * registered MCP tools. Workspace beats global; per-tool beats per-server.
 */
export function computeEffective(globalServers, wsOverrides, tools) {
  const deny = []
  const ws = wsOverrides?.servers ?? {}
  for (const t of tools) {
    const g = globalServers?.[t.server]
    const w = ws[t.server]
    const serverOn = (() => {
      const v = normalizeTriState(w?.enabled)
      if (v === 'on') return true
      if (v === 'off') return false
      return g?.enabled ?? true
    })()
    if (!serverOn) {
      deny.push(t.publicName)
      continue
    }
    const toolOn = (() => {
      const v = normalizeTriState(w?.tools?.[t.tool])
      if (v === 'on') return true
      if (v === 'off') return false
      return g?.tools?.[t.tool] ?? true
    })()
    if (!toolOn) deny.push(t.publicName)
  }
  return deny
}

/** Parse a patch-file document and return the mcp-client rows. */
export function parsePatchServers(text) {
  let doc
  try {
    doc = yaml.load(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  const rows = []
  for (const entry of doc) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const ins = entry.insert
    const items = Array.isArray(ins) ? ins : ins !== null && typeof ins === 'object' ? [ins] : []
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      if (typeof item.name !== 'string' || !item.name.includes('dsh-mcp-client')) continue
      const cfg = item.config !== null && typeof item.config === 'object' && !Array.isArray(item.config) ? item.config : {}
      rows.push({
        id: item.id,
        name: item.name,
        serverName: typeof cfg.serverName === 'string' ? cfg.serverName : item.id,
        transport: cfg.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: typeof cfg.command === 'string' ? cfg.command : '',
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: cfg.env !== null && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? cfg.env : {},
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : '',
        url: typeof cfg.url === 'string' ? cfg.url : '',
        headers: cfg.headers !== null && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers) ? cfg.headers : {},
        toolCallTimeoutMs: typeof cfg.toolCallTimeoutMs === 'number' ? cfg.toolCallTimeoutMs : undefined
      })
    }
  }
  return rows
}

/** Render one row as a 4-space-indented YAML block (without the `- insert:` wrapper). */
export function rowBlockYaml(row) {
  const lines = []
  const push = (indent, text) => lines.push(`${' '.repeat(indent)}${text}`)
  const q = (value) => {
    const str = String(value)
    if (/^[A-Za-z0-9_./-]+$/.test(str) && !['null', 'true', 'false', 'yes', 'no', 'on', 'off', '~'].includes(str)) return str
    // Single-quote YAML scalars (doubling inner quotes); falls back to JSON
    // for strings containing control characters or newlines.
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\n\r]/.test(str)) return `'${str.replace(/'/g, "''")}'`
    return JSON.stringify(str)
  }
  push(4, `- id: ${q(row.id)}`)
  push(6, `name: ${q(row.name ?? MCP_CLIENT_NAME)}`)
  if (row.transport === 'streamable-http') {
    push(6, 'config:')
    push(8, `serverName: ${q(row.serverName)}`)
    push(8, 'transport: streamable-http')
    push(8, `url: ${q(row.url ?? '')}`)
    if (row.headers && Object.keys(row.headers).length > 0) {
      push(8, 'headers:')
      for (const [k, v] of Object.entries(row.headers)) push(10, `${q(k)}: ${q(String(v))}`)
    }
  } else {
    push(6, 'config:')
    push(8, `serverName: ${q(row.serverName)}`)
    push(8, 'transport: stdio')
    push(8, `command: ${q(row.command ?? '')}`)
    const args = Array.isArray(row.args) ? row.args : []
    if (args.length > 0) {
      push(8, 'args:')
      for (const a of args) push(10, `- ${q(String(a))}`)
    }
    const env = row.env && typeof row.env === 'object' ? row.env : {}
    if (Object.keys(env).length > 0) {
      push(8, 'env:')
      for (const [k, v] of Object.entries(env)) push(10, `${q(k)}: ${q(String(v))}`)
    }
    if (row.cwd) push(8, `cwd: ${q(row.cwd)}`)
  }
  if (typeof row.toolCallTimeoutMs === 'number') push(8, `toolCallTimeoutMs: ${row.toolCallTimeoutMs}`)
  return lines.join('\n')
}

/**
 * Locate the text block of each mcp-client row in a patch file.
 * Returns a map id -> { entryStart, start, end } where [start, end) is the
 * row block (4-space `- id:` lines) and entryStart is its `- insert:` line
 * when this row is the entry's only row.
 */
export function findRowBlocks(text, ids) {
  const lines = text.split('\n')
  const result = {}
  const isRowStart = (line) => /^\s{0,4}- id:/.test(line) && !/^\s+- id:/.test(line.slice(0, 8))
  // Find all row starts with their ids
  const rowStarts = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {4}- id:\s*(?:'([^']+)'|"([^"]+)"|([^#\s]+))/)
    if (!m) continue
    const id = m[1] ?? m[2] ?? m[3]
    if (id === undefined) continue
    rowStarts.push({ index: i, id })
  }
  // Row end: next row start, next top-level list item (`- ` at col 0), next
  // top-level key (non-space first char), or EOF.
  const endOf = (startIndex) => {
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^ {4}- /.test(line)) return i // next row in the same entry
      if (/^- /.test(line)) return i // next top-level entry
      if (/^\S/.test(line)) return i // top-level key / comment
    }
    return lines.length
  }
  for (const rs of rowStarts) {
    if (!ids.includes(rs.id)) continue
    const end = endOf(rs.index)
    let entryStart = -1
    for (let i = rs.index - 1; i >= 0; i--) {
      if (/^- insert:/.test(lines[i])) { entryStart = i; break }
      if (/^\S/.test(lines[i])) break
    }
    result[rs.id] = { entryStart, start: rs.index, end }
  }
  return result
}

/** Replace (or append when the id is new) one row block in the patch text. */
export function upsertRowBlock(text, row) {
  const existing = parsePatchServers(text).map((r) => r.id)
  const block = rowBlockYaml(row)
  if (existing.includes(row.id)) {
    const blocks = findRowBlocks(text, [row.id])
    const b = blocks[row.id]
    if (!b) {
      // Could not locate the row textually — fall back to a full re-dump.
      return appendRowBlock(text, row, true)
    }
    const lines = text.split('\n')
    const before = lines.slice(0, b.start)
    const after = lines.slice(b.end)
    return [...before, block, ...after].join('\n')
  }
  return appendRowBlock(text, row)
}

/** Remove one row block (and its empty `- insert:` entry when sole). */
export function removeRowBlock(text, id) {
  const blocks = findRowBlocks(text, [id])
  const b = blocks[id]
  if (!b) return text
  const lines = text.split('\n')
  let start = b.start
  let end = b.end
  if (b.entryStart >= 0 && b.entryStart === b.start - 1) {
    // The row is the entry's only content: check nothing follows inside it.
    let sole = true
    for (let i = b.start + 1; i < b.end; i++) {
      if (/^ {4}- /.test(lines[i])) { sole = false; break }
    }
    if (sole) start = b.entryStart
  }
  const out = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}

/** Append a new `- insert:` entry with one row at the end of the patch text. */
export function appendRowBlock(text, row, fallbackDump = false) {
  const block = rowBlockYaml(row)
  let out = text
  if (out.length > 0 && !out.endsWith('\n')) out += '\n'
  if (out.trim().length === 0) {
    out = '# mcp-manager managed MCP server entries (managed by the MCP manager settings page)\n'
  }
  const entry = `- insert:\n${block}\n`
  const next = out + entry
  if (fallbackDump) {
    // Keep the original document semantics but the row was not textually
    // located: append the new row under a fresh entry (the loader merges
    // inserts, and the old row is left untouched).
    return next
  }
  return next
}

/** Build a row object from client input (whitelisted fields only). */
export function normalizeServerInput(input) {
  const serverName = String(input?.serverName ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error('serverName 必须是 1-32 位字母/数字/下划线/连字符')
  }
  const transport = input?.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const row = {
    id: String(input?.id ?? `mcp-${serverName}`).trim() || `mcp-${serverName}`,
    name: MCP_CLIENT_NAME,
    serverName,
    transport,
    command: transport === 'stdio' ? String(input?.command ?? '').trim() : '',
    args: Array.isArray(input?.args) ? input.args.map((a) => String(a)) : [],
    env: input?.env && typeof input.env === 'object' && !Array.isArray(input.env)
      ? Object.fromEntries(Object.entries(input.env).map(([k, v]) => [String(k), String(v)]))
      : {},
    cwd: String(input?.cwd ?? '').trim(),
    url: transport === 'streamable-http' ? String(input?.url ?? '').trim() : '',
    headers: input?.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
      ? Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [String(k), String(v)]))
      : {}
  }
  if (typeof input?.toolCallTimeoutMs === 'number' && Number.isFinite(input.toolCallTimeoutMs) && input.toolCallTimeoutMs > 0) {
    row.toolCallTimeoutMs = Math.round(input.toolCallTimeoutMs)
  }
  if (transport === 'stdio' && !row.command) throw new Error('stdio transport 需要 command')
  if (transport === 'streamable-http' && !row.url) throw new Error('streamable-http transport 需要 url')
  return row
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

const inject = ['tools', 'agents', 'settings']

function apply(ctx, config) {
  return (async () => {
    try {
      await debugLog('apply: begin')
      return await applyInner(ctx, config)
    } catch (e) {
      await debugLog(`apply: FATAL ${String(e && e.stack || e)}`)
      throw e
    }
  })()
}

async function applyInner(ctx, config) {
  const workspaceRel = config.workspaceFile

  /** Cache of workspace overrides by canonical cwd. */
  const overrideCache = new Map()

  async function readOverrides(cwd) {
    if (overrideCache.has(cwd)) return overrideCache.get(cwd)
    const overrides = await readWorkspaceFile(cwd)
    overrideCache.set(cwd, overrides)
    return overrides
  }
  function invalidateOverrides(cwd) {
    overrideCache.delete(cwd)
  }

  async function readWorkspaceFile(cwd) {
    const file = join(cwd, workspaceRel)
    try {
      const text = await readFile(file, 'utf8')
      return normalizeWorkspaceFile(yaml.load(text))
    } catch (error) {
      if (error?.code === 'ENOENT') return { servers: {} }
      throw error
    }
  }

  async function writeWorkspaceFile(cwd, overrides) {
    const file = join(cwd, workspaceRel)
    const pruned = pruneWorkspaceFile(overrides)
    if (Object.keys(pruned.servers).length === 0) {
      try {
        await rm(file, { force: true })
      } catch {}
      invalidateOverrides(cwd)
      return
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, yaml.dump(pruned, { noRefs: true }), 'utf8')
    invalidateOverrides(cwd)
  }

  /** Current global config from the settings scope (defaults when absent). */
  function globalConfig() {
    const scope = settingsScope
    if (scope === undefined) return { servers: {} }
    const value = scope.get()
    if (value === null || typeof value !== 'object') return { servers: {} }
    const servers = value.servers !== null && typeof value.servers === 'object' ? value.servers : {}
    return { servers }
  }

  let settingsScope
  const settingsSvc = ctx.get('settings')
  await debugLog(`apply: settings=${settingsSvc !== undefined} tools=${ctx.get('tools') !== undefined} agents=${ctx.get('agents') !== undefined} webServer=${ctx.get('webServer') !== undefined} workspaceRegistry=${ctx.get('workspaceRegistry') !== undefined} baseUrl=${String(ctx.baseUrl)}`)
  if (settingsSvc !== undefined) {
    try {
      settingsScope = settingsSvc.register(settingsNamespace(NS), GlobalSchema)
      await debugLog('apply: settings scope registered')
      ctx.effect(() => settingsScope.watch(() => {
        engine.applyAll(liveAgents())
      }), 'mcp-manager: settings watch')
    } catch (e) {
      await debugLog(`apply: settings register FAILED ${String(e && e.stack || e)}`)
      throw e
    }
  } else {
    await debugLog('apply: settings service missing — global persistence disabled')
  }

  const toolsSvc = ctx.get('tools')
  const agentsSvc = ctx.get('agents')

  /** Live MCP server/tool inventory: serverName -> { tools: [...] }. */
  const inventory = new Map()

  function refreshInventory() {
    inventory.clear()
    if (toolsSvc === undefined) return
    let schemas = []
    try {
      schemas = toolsSvc.schemas()
    } catch {
      return
    }
    if (!Array.isArray(schemas)) return
    for (const schema of schemas) {
      if (schema === null || typeof schema !== 'object') continue
      const publicName = schema.name
      if (typeof publicName !== 'string' || !publicName.startsWith(MCP_PREFIX)) continue
      const rest = publicName.slice(MCP_PREFIX.length)
      const sep = rest.indexOf('__')
      if (sep <= 0) continue
      const server = rest.slice(0, sep)
      const tool = rest.slice(sep + 2)
      if (!server || !tool) continue
      let entry = inventory.get(server)
      if (entry === undefined) {
        entry = { connected: true, tools: [] }
        inventory.set(server, entry)
      }
      entry.tools.push({
        name: tool,
        description: typeof schema.description === 'string' ? schema.description : '',
        publicName,
        server,
        tool
      })
    }
  }

  function liveAgents() {
    if (agentsSvc === undefined) return []
    try {
      const list = agentsSvc.list()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /** Per-agent restriction disposers and signatures. */
  const restrictions = new Map()
  const signatures = new Map()
  let reapplying = false

  const engine = {
    async apply(agent) {
      if (agent === null || typeof agent !== 'object') return
      let deny = []
      try {
        const cwd = agent.session?.header?.cwd
        if (cwd) {
          const overrides = await readOverrides(cwd)
          deny = computeEffective(globalConfig().servers, overrides, [...inventory.values()].flatMap((e) => e.tools))
        }
      } catch (error) {
        ctx.logger?.warn?.(`mcp-manager: effective config for agent ${agent.id} failed: ${String(error)}`)
        return
      }
      const sig = deny.join('\u0001')
      if (signatures.get(agent) === sig) return
      const prev = restrictions.get(agent)
      const toolsSvcOf = agent.ctx?.tools
      if (toolsSvcOf === undefined || typeof toolsSvcOf.restrict !== 'function') {
        if (prev) {
          try { prev() } catch {}
          restrictions.delete(agent)
        }
        signatures.set(agent, sig)
        return
      }
      try {
        const disposer = toolsSvcOf.restrict({ deny })
        if (prev) {
          try { prev() } catch {}
        }
        restrictions.set(agent, disposer)
        signatures.set(agent, sig)
      } catch (error) {
        ctx.logger?.warn?.(`mcp-manager: tools.restrict for agent ${agent.id} failed: ${String(error)}`)
      }
    },
    drop(agent) {
      const prev = restrictions.get(agent)
      if (prev) {
        try { prev() } catch {}
      }
      restrictions.delete(agent)
      signatures.delete(agent)
    },
    applyAll(agents) {
      if (reapplying) return
      reapplying = true
      queueMicrotask(() => {
        reapplying = false
        for (const agent of agents) {
          engine.apply(agent).catch(() => {})
        }
      })
    }
  }

  // Initial pass over already-live agents (this plugin mounts after boot).
  refreshInventory()
  engine.applyAll(liveAgents())

  // Agent lifecycle.
  ctx.on('agent/created', (payload) => {
    engine.apply(payload?.agent).catch(() => {})
  })
  ctx.on('agent/disposed', (payload) => {
    engine.drop(payload?.agent)
  })
  ctx.on('agent/session-start', (payload) => {
    // Cheap re-read of the workspace file (covers hand-edits between turns).
    if (payload?.agent?.session?.header?.cwd) invalidateOverrides(payload.agent.session.header.cwd)
    engine.apply(payload?.agent).catch(() => {})
  })

  // Tool inventory changes (mcp-client connect / re-sync / disconnect).
  ctx.on('tools/change', () => {
    refreshInventory()
    engine.applyAll(liveAgents())
  })

  // -------------------------------------------------------------------------
  // Patch-file CRUD helpers
  // -------------------------------------------------------------------------
  const patchPath = join(fileURLToPath(ctx.baseUrl), 'cordis.patch.yml')

  async function readPatchText() {
    try {
      return await readFile(patchPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return ''
      throw error
    }
  }

  async function writePatchText(text) {
    // Validate before persisting: the written text must parse and keep the
    // same mcp-client rows.
    const parsed = yaml.load(text)
    if (!Array.isArray(parsed)) throw new Error('写入失败：patch 文件解析结果不是数组')
    await writeFile(patchPath, text, 'utf8')
  }

  async function listServers() {
    return parsePatchServers(await readPatchText())
  }

  // -------------------------------------------------------------------------
  // HTTP API (client page transport)
  // -------------------------------------------------------------------------
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    try {
      webServer.register({
        kind: 'prefix',
        path: '/api/mcp-manager',
        handler: async (req, res) => {
        const json = (status, body) => {
          const text = JSON.stringify(body ?? {})
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(text)
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname
          if (req.method === 'GET' && path === '/api/mcp-manager/state') {
            refreshInventory()
            const servers = await listServers()
            let registryRows = []
            const wreg = ctx.get('workspaceRegistry')
            if (wreg !== undefined && typeof wreg.list === 'function') {
              try { registryRows = wreg.list() || [] } catch (e) { registryRows = [] }
            }
            if (registryRows.length === 0) {
              // workspaceRegistry service unavailable in this composition —
              // fall back to the durable storage document directly.
              try {
                const text = await readFile(join(process.env.HOME || '', '.dsh', 'storages', 'workspace.json'), 'utf8')
                const doc = JSON.parse(text)
                const tables = doc && doc.tables && doc.tables.workspaces ? doc.tables.workspaces : {}
                registryRows = Object.values(tables).map((w) => ({
                  path: w.path,
                  title: w.title
                }))
              } catch (e) {}
            }
            const workspaces = []
            for (const ws of registryRows) {
              if (!ws || typeof ws.path !== 'string') continue
              const overrides = await readOverrides(ws.path)
              workspaces.push({
                path: ws.path,
                title: ws.title || ws.path,
                overrides: overrides.servers
              })
            }
            const live = {}
            for (const [server, entry] of inventory) {
              live[server] = { connected: entry.connected, tools: entry.tools }
            }
            json(200, { ok: true, servers, live, workspaces, patchPath, global: globalConfig().servers })
            return
          }
          if (req.method === 'POST' && path === '/api/mcp-manager/workspace') {
            const body = await readJsonBody(req)
            const cwd = String(body?.path ?? '').trim()
            if (!cwd) throw new Error('缺少 path')
            const current = await readOverrides(cwd)
            const serverName = String(body?.serverName ?? '').trim()
            if (!serverName) throw new Error('缺少 serverName')
            const cfg = current.servers[serverName] ?? { enabled: 'inherit', tools: {} }
            if (body?.enabled !== undefined) cfg.enabled = normalizeTriState(body.enabled)
            if (body?.tool !== undefined && body?.toolState !== undefined) {
              cfg.tools[String(body.tool)] = normalizeTriState(body.toolState)
            }
            current.servers[serverName] = cfg
            await writeWorkspaceFile(cwd, current)
            engine.applyAll(liveAgents())
            json(200, { ok: true })
            return
          }
          if (req.method === 'POST' && path === '/api/mcp-manager/workspace/reset') {
            const body = await readJsonBody(req)
            const cwd = String(body?.path ?? '').trim()
            if (!cwd) throw new Error('缺少 path')
            const current = await readOverrides(cwd)
            const serverName = String(body?.serverName ?? '').trim()
            if (serverName) {
              delete current.servers[serverName]
            } else {
              current.servers = {}
            }
            await writeWorkspaceFile(cwd, current)
            engine.applyAll(liveAgents())
            json(200, { ok: true })
            return
          }
          if (req.method === 'POST' && path === '/api/mcp-manager/global') {
            const body = await readJsonBody(req)
            const serverName = String(body?.serverName ?? '').trim()
            if (!serverName) throw new Error('缺少 serverName')
            const scope = settingsScope
            if (scope === undefined) throw new Error('全局配置不可用：settings 服务未注册')
            // The resolved settings value is deep-frozen; never mutate it —
            // copy each layer before changing a leaf.
            const srcServers = globalConfig().servers || {}
            const src = srcServers[serverName] || {}
            const cfg = {
              enabled: typeof src.enabled === 'boolean' ? src.enabled : true,
              tools: Object.assign({}, src.tools || {})
            }
            if (body?.enabled !== undefined) cfg.enabled = Boolean(body.enabled)
            if (body?.tool !== undefined && body?.toolEnabled !== undefined) {
              cfg.tools[String(body.tool)] = Boolean(body.toolEnabled)
            }
            const servers = Object.assign({}, srcServers, { [serverName]: cfg })
            await scope.update({ servers })
            engine.applyAll(liveAgents())
            json(200, { ok: true })
            return
          }
          if (req.method === 'POST' && path === '/api/mcp-manager/server') {
            const body = await readJsonBody(req)
            const action = body?.action
            if (action === 'upsert') {
              const row = normalizeServerInput(body)
              let text = await readPatchText()
              text = upsertRowBlock(text, row)
              await writePatchText(text)
              json(200, { ok: true, servers: await listServers() })
              return
            }
            if (action === 'remove') {
              const id = String(body?.id ?? '').trim()
              if (!id) throw new Error('缺少 id')
              let text = await readPatchText()
              const before = parsePatchServers(text)
              if (!before.some((r) => r.id === id)) throw new Error(`未找到 id: ${id}`)
              text = removeRowBlock(text, id)
              await writePatchText(text)
              json(200, { ok: true, servers: await listServers() })
              return
            }
            throw new Error('未知 action')
          }
          json(404, { ok: false, error: 'not found' })
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      })
      await debugLog('apply: webServer route registered')
    } catch (e) {
      await debugLog(`apply: webServer register FAILED ${String(e && e.stack || e)}`)
      throw e
    }
  } else {
    await debugLog('apply: webServer service missing — HTTP API disabled')
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------
  ctx.effect(() => {
    return () => {
      for (const dispose of restrictions.values()) {
        try { dispose() } catch {}
      }
      restrictions.clear()
      signatures.clear()
    }
  }, 'mcp-manager: restrictions teardown')
}

/** Read a JSON request body with a size cap. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

export { apply, Config, inject, name }

/**
 * Standalone tests for dsh-mcp-manager host pure helpers.
 * Run: node test-host.mjs
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import {
  normalizeTriState,
  normalizeWorkspaceFile,
  pruneWorkspaceFile,
  computeEffective,
  parsePatchServers,
  rowBlockYaml,
  findRowBlocks,
  upsertRowBlock,
  removeRowBlock,
  appendRowBlock,
  normalizeServerInput
} from './lib/index.js'

let passed = 0
function ok(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

console.log('== normalizeTriState ==')
ok('boolean true -> on', () => assert.equal(normalizeTriState(true), 'on'))
ok('boolean false -> off', () => assert.equal(normalizeTriState(false), 'off'))
ok('string on/off/inherit pass through', () => {
  assert.equal(normalizeTriState('on'), 'on')
  assert.equal(normalizeTriState('off'), 'off')
  assert.equal(normalizeTriState('inherit'), 'inherit')
})
ok('garbage -> fallback', () => assert.equal(normalizeTriState('banana'), 'inherit'))

console.log('== normalizeWorkspaceFile / pruneWorkspaceFile ==')
const raw = {
  servers: {
    dbx: { enabled: false, tools: { dbx_execute_query: 'off', dbx_list_connections: true, dbx_open_table: 'inherit' } },
    other: { enabled: 'inherit' }
  }
}
const norm = normalizeWorkspaceFile(raw)
ok('normalizes nested tri-state', () => {
  assert.deepEqual(norm.servers.dbx.enabled, 'off')
  assert.deepEqual(norm.servers.dbx.tools.dbx_execute_query, 'off')
  assert.deepEqual(norm.servers.dbx.tools.dbx_list_connections, 'on')
  assert.deepEqual(norm.servers.dbx.tools.dbx_open_table, 'inherit')
  assert.deepEqual(norm.servers.other.enabled, 'inherit')
})
const pruned = pruneWorkspaceFile(norm)
ok('prune drops inherit entries', () => {
  assert.equal(pruned.servers.dbx.enabled, 'off')
  assert.equal('other' in pruned.servers, false)
  assert.deepEqual(pruned.servers.dbx.tools, { dbx_execute_query: 'off', dbx_list_connections: 'on' })
})
ok('normalize handles null', () => {
  assert.deepEqual(normalizeWorkspaceFile(null), { servers: {} })
  assert.deepEqual(normalizeWorkspaceFile(undefined), { servers: {} })
})

console.log('== computeEffective ==')
const tools = [
  { server: 'dbx', tool: 'dbx_execute_query', publicName: 'mcp__dbx__dbx_execute_query' },
  { server: 'dbx', tool: 'dbx_list_connections', publicName: 'mcp__dbx__dbx_list_connections' },
  { server: 'git', tool: 'git_status', publicName: 'mcp__git__git_status' }
]
ok('all default -> no deny', () => {
  assert.deepEqual(computeEffective({}, { servers: {} }, tools), [])
})
ok('global server off -> deny all its tools', () => {
  assert.deepEqual(computeEffective({ dbx: { enabled: false } }, { servers: {} }, tools), [
    'mcp__dbx__dbx_execute_query',
    'mcp__dbx__dbx_list_connections'
  ])
})
ok('global tool off -> deny that tool only', () => {
  assert.deepEqual(computeEffective({ dbx: { enabled: true, tools: { dbx_execute_query: false } } }, { servers: {} }, tools), [
    'mcp__dbx__dbx_execute_query'
  ])
})
ok('workspace server off overrides global on', () => {
  assert.deepEqual(computeEffective({ dbx: { enabled: true } }, { servers: { dbx: { enabled: 'off' } } }, tools), [
    'mcp__dbx__dbx_execute_query',
    'mcp__dbx__dbx_list_connections'
  ])
})
ok('workspace tool on overrides global off', () => {
  assert.deepEqual(
    computeEffective({ dbx: { enabled: true, tools: { dbx_execute_query: false } } },
      { servers: { dbx: { tools: { dbx_execute_query: 'on' } } } }, tools),
    []
  )
})
ok('workspace inherit follows global', () => {
  assert.deepEqual(computeEffective({ dbx: { enabled: false } }, { servers: { dbx: { enabled: 'inherit' } } }, tools), [
    'mcp__dbx__dbx_execute_query',
    'mcp__dbx__dbx_list_connections'
  ])
})

console.log('== scanInventory-shape regression (dynamic + persistent host) ==')
// scanInventory emits { name, description, publicName, server, tool }; the old
// code omitted server/tool so computeEffective could never deny anything.
const scanTools = [
  { name: 'dbx_execute_query', description: '', publicName: 'mcp__dbx__dbx_execute_query', server: 'dbx', tool: 'dbx_execute_query' },
  { name: 'dbx_list_connections', description: '', publicName: 'mcp__dbx__dbx_list_connections', server: 'dbx', tool: 'dbx_list_connections' }
]
ok('scan-inventory shape + global tool off -> denies that public name', () => {
  assert.deepEqual(
    computeEffective({ dbx: { enabled: true, tools: { dbx_execute_query: false } } }, { servers: {} }, scanTools),
    ['mcp__dbx__dbx_execute_query']
  )
})
ok('scan-inventory shape + server off -> denies all tools', () => {
  assert.deepEqual(
    computeEffective({ dbx: { enabled: false } }, { servers: {} }, scanTools),
    ['mcp__dbx__dbx_execute_query', 'mcp__dbx__dbx_list_connections']
  )
})
ok('scan-inventory shape + workspace tool off -> denies that tool', () => {
  assert.deepEqual(
    computeEffective({ dbx: { enabled: true } }, { servers: { dbx: { tools: { dbx_execute_query: 'off' } } } }, scanTools),
    ['mcp__dbx__dbx_execute_query']
  )
})

console.log('== parsePatchServers (real profile patch) ==')
const realPatch = await readFile('/Users/deimoe/.dsh/profiles/web/cordis.patch.yml', 'utf8')
const realServers = parsePatchServers(realPatch)
ok('parses the real patch file rows', () => {
  assert.ok(realServers.length >= 1)
  const dbx = realServers.find((r) => r.serverName === 'dbx')
  assert.ok(dbx, 'dbx server found')
  assert.equal(dbx.transport, 'stdio')
  assert.ok(dbx.command.length > 0)
  console.log('    rows:', realServers.map((r) => `${r.id} (${r.serverName}, ${r.transport})`).join(', '))
})

console.log('== rowBlockYaml ==')
const sampleRow = normalizeServerInput({
  id: 'mcp-demo',
  serverName: 'demo',
  transport: 'stdio',
  command: '/usr/bin/node',
  args: ['/opt/server.js', '--flag'],
  env: { TOKEN: 'abc def' },
  toolCallTimeoutMs: 45000
})
ok('builds a valid stdio row', () => {
  const block = rowBlockYaml(sampleRow)
  assert.ok(block.includes('- id: mcp-demo'))
  assert.ok(block.includes("name: '@deepseek-ai/dsh-mcp-client'"))
  assert.ok(block.includes('command: /usr/bin/node'))
  assert.ok(block.includes("TOKEN: 'abc def'"))
  assert.ok(block.includes('toolCallTimeoutMs: 45000'))
  // The block must re-parse to the same row
  const reparsed = parsePatchServers(`- insert:\n${block}\n`)
  assert.equal(reparsed[0].serverName, 'demo')
  assert.deepEqual(reparsed[0].args, ['/opt/server.js', '--flag'])
  assert.deepEqual(reparsed[0].env, { TOKEN: 'abc def' })
  assert.equal(reparsed[0].toolCallTimeoutMs, 45000)
})
ok('streamable-http row', () => {
  const httpRow = normalizeServerInput({ serverName: 'remote', transport: 'streamable-http', url: 'https://x.example/mcp' })
  const block = rowBlockYaml(httpRow)
  assert.ok(block.includes('transport: streamable-http'))
  assert.ok(block.includes("url: 'https://x.example/mcp'"))
})

console.log('== patch surgery ==')
// Synthetic patch with comments + two rows + another non-mcp row
const synth = `# my comments
- insert:
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: stdio
        command: /usr/bin/node
        args:
          - /opt/dbx.js
- insert:
    - id: mcp-git
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: git
        transport: stdio
        command: /usr/bin/node
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
`
ok('upsert new row appends entry and preserves others', () => {
  const next = upsertRowBlock(synth, normalizeServerInput({ id: 'mcp-demo', serverName: 'demo', command: '/bin/x' }))
  const servers = parsePatchServers(next)
  const ids = servers.map((r) => r.id)
  assert.deepEqual(ids, ['mcp-dbx', 'mcp-git', 'mcp-demo'])
  assert.ok(next.includes('# my comments'), 'comments preserved')
  assert.ok(next.includes("name: 'dsh-better-sidebar'"), 'non-mcp row preserved')
})
ok('upsert existing row replaces in place', () => {
  const next = upsertRowBlock(synth, normalizeServerInput({ id: 'mcp-dbx', serverName: 'dbx', command: '/usr/bin/node', args: ['/opt/dbx-v2.js'] }))
  const servers = parsePatchServers(next)
  const dbx = servers.find((r) => r.id === 'mcp-dbx')
  assert.deepEqual(dbx.args, ['/opt/dbx-v2.js'])
  assert.ok(next.includes('# my comments'), 'comments preserved')
  assert.ok(next.includes('mcp-git'), 'sibling row preserved')
  // only one mcp-dbx
  assert.equal(servers.filter((r) => r.id === 'mcp-dbx').length, 1)
})
ok('remove row with entry cleanup', () => {
  const next = removeRowBlock(synth, 'mcp-git')
  const servers = parsePatchServers(next)
  assert.deepEqual(servers.map((r) => r.id), ['mcp-dbx'])
  assert.ok(next.includes('# my comments'), 'comments preserved')
  assert.ok(!next.includes('mcp-git'), 'row text gone')
  assert.ok(next.includes('better-sidebar'), 'non-mcp row preserved')
})
ok('remove sole row removes its empty entry', () => {
  const solo = `- insert:\n    - id: mcp-only\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: only\n        transport: stdio\n        command: /x\n`
  const next = removeRowBlock(solo, 'mcp-only')
  assert.ok(!next.includes('mcp-only'))
  assert.ok(!next.includes('insert'))
  assert.ok(parsePatchServers(next).length === 0)
})
ok('findRowBlocks locates ids', () => {
  const blocks = findRowBlocks(synth, ['mcp-dbx', 'mcp-git', 'missing'])
  assert.ok(blocks['mcp-dbx'].start >= 0)
  assert.ok(blocks['mcp-dbx'].end > blocks['mcp-dbx'].start)
  assert.ok(blocks['mcp-git'].start > blocks['mcp-dbx'].end)
  assert.equal(blocks['missing'], undefined)
})
ok('round-trip on the real patch preserves semantics', () => {
  const first = realServers[0]
  if (!first) return
  const next = upsertRowBlock(realPatch, first)
  const after = parsePatchServers(next)
  assert.equal(after.length, realServers.length)
  const round2 = removeRowBlock(next, first.id)
  const after2 = parsePatchServers(round2)
  assert.equal(after2.length, realServers.length - 1)
  assert.equal(parsePatchServers(removeRowBlock(realPatch, 'definitely-not-there')).length, realServers.length)
})

console.log('== normalizeServerInput ==')
ok('validates serverName', () => {
  assert.throws(() => normalizeServerInput({ serverName: 'bad name!' }))
  assert.throws(() => normalizeServerInput({ serverName: '' }))
  assert.throws(() => normalizeServerInput({ serverName: 'x'.repeat(40) }))
})
ok('requires command for stdio, url for http', () => {
  assert.throws(() => normalizeServerInput({ serverName: 'a' }))
  assert.throws(() => normalizeServerInput({ serverName: 'a', transport: 'streamable-http' }))
  assert.ok(normalizeServerInput({ serverName: 'a', command: '/x' }))
  assert.ok(normalizeServerInput({ serverName: 'a', transport: 'streamable-http', url: 'https://x' }))
})
ok('defaults id from serverName', () => {
  assert.equal(normalizeServerInput({ serverName: 'demo', command: '/x' }).id, 'mcp-demo')
})

console.log(`\n${passed} checks passed`)

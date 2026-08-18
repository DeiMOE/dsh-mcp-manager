/**
 * Generates the two client artifacts from src/client-core.js:
 *   1. dynamic-client.js  — the function body for cordis_define code.client
 *   2. lib/client.js      — the persistent __ModuleLoader__ bundle
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const core = await readFile(join(root, 'src/client-core.js'), 'utf8')

const PERSISTENT_TRANSPORT = `
function createTransport(ctx) {
  async function fetchJson(path, body) {
    const res = await fetch(path, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let data = {}
    try { data = JSON.parse(text || '{}') } catch (e) { data = { ok: false, error: text } }
    if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status))
    return data
  }
  async function call(method, args) {
    if (method === 'state') {
      return fetchJson('/api/mcp-manager/state')
    }
    if (method === 'setGlobalServer') {
      return fetchJson('/api/mcp-manager/global', { serverName: args.server, enabled: !!args.enabled })
    }
    if (method === 'setGlobalTool') {
      return fetchJson('/api/mcp-manager/global', { serverName: args.server, tool: args.tool, toolEnabled: !!args.enabled })
    }
    if (method === 'setWorkspace') {
      return fetchJson('/api/mcp-manager/workspace', Object.assign({ path: args.path, serverName: args.serverName }, args.patch))
    }
    if (method === 'resetWorkspace') {
      return fetchJson('/api/mcp-manager/workspace/reset', { path: args.path, serverName: args.serverName })
    }
    if (method === 'upsertServer') {
      return fetchJson('/api/mcp-manager/server', Object.assign({ action: 'upsert' }, args.row))
    }
    if (method === 'removeServer') {
      return fetchJson('/api/mcp-manager/server', { action: 'remove', id: args.id })
    }
    throw new Error('unknown method ' + method)
  }
  return {
    call,
    onExternalChange: () => () => {}
  }
}
`

const DYNAMIC_TRANSPORT = `
function createTransport(ctx) {
  return {
    call: (method, args) => host.call(method, args),
    onExternalChange: () => () => {}
  }
}
`

// ---------------------------------------------------------------------------
// Dynamic client body
// ---------------------------------------------------------------------------
// The `return buildClient(...)` sits FIRST so an end-truncated paste can never
// silently drop it (the runner rejects a body whose last executed statement is
// not `return`). buildClient/createTransport are hoisted function declarations;
// `styles.insert(CSS)` moved into buildClient.apply with a guard.
const dynamicBody = `const h = React.createElement;
return buildClient(React, styles, createTransport);

${core}

${DYNAMIC_TRANSPORT}
`

await writeFile(join(root, 'dynamic-client.js'), dynamicBody)

// ---------------------------------------------------------------------------
// Persistent bundle
// ---------------------------------------------------------------------------
const bundle = `window.__ModuleLoader__.load({
	id: "dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const h = React.createElement;
${indent(core, '\t\t')}

${indent(PERSISTENT_TRANSPORT, '\t\t')}

		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\\"dsh-mcp-manager\\"]")) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mcp-manager";
			tag.dataset.pluginCss = "dsh-mcp-manager";
			tag.textContent = getCSS();
			document.head.appendChild(tag);
		}
		const plugin = buildClient(React, null, createTransport);
		exports.apply = plugin.apply;
		exports.inject = plugin.inject;
		return module.exports;
	}
});
`
await writeFile(join(root, 'lib/client.js'), bundle)

console.log('dynamic-client.js:', dynamicBody.length, 'bytes')
console.log('lib/client.js:', bundle.length, 'bytes')

function indent(text, pad) {
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n')
}

window.__ModuleLoader__.load({
	id: "dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const h = React.createElement;
		/**
		 * dsh-mcp-manager client core — shared verbatim between:
		 *  - the dynamic plugin client half (symbols: React, styles, host)
		 *  - the persistent bundle lib/client.js (symbols: require('react'), fetch)
		 *
		 * Plain JavaScript only; UI built with React.createElement. The plugin is
		 * parameterized by `createTransport(ctx)` which returns:
		 *   { call(method, args): Promise<any>, onExternalChange(cb): disposer }
		 */
		'use strict';

		const NS = 'dsh-mcp-manager';

		/* ============================== api layer ============================== */

		function makeApi(transport) {
		  return {
		    async getState() {
		      return transport.call('state', null)
		    },
		    async setGlobalServer(server, enabled) {
		      return transport.call('setGlobalServer', { server, enabled })
		    },
		    async setGlobalTool(server, tool, enabled) {
		      return transport.call('setGlobalTool', { server, tool, enabled })
		    },
		    async setWorkspace(path, serverName, patch) {
		      return transport.call('setWorkspace', { path, serverName, patch })
		    },
		    async resetWorkspace(path, serverName) {
		      return transport.call('resetWorkspace', { path, serverName })
		    },
		    async upsertServer(row) {
		      return transport.call('upsertServer', { row })
		    },
		    async removeServer(id) {
		      return transport.call('removeServer', { id })
		    }
		  }
		}

		function triLabel(state) {
		  return state === 'on' ? 1 : state === 'off' ? 2 : 0
		}

		/* ============================== small UI bits ============================== */

		function Toggle({ checked, disabled, onChange, title }) {
		  return h(
		    'button',
		    {
		      type: 'button',
		      title: title || '',
		      disabled: !!disabled,
		      'aria-checked': !!checked,
		      role: 'switch',
		      className: 'mcp-toggle' + (checked ? ' mcp-toggle-on' : ''),
		      onClick: (e) => {
		        e.stopPropagation()
		        if (!disabled) onChange(!checked)
		      }
		    },
		    h('span', { className: 'mcp-toggle-knob' })
		  )
		}

		function TriSelect({ value, onChange, labels, disabled }) {
		  const v = triLabel(value)
		  return h(
		    'select',
		    {
		      className: 'mcp-triselect',
		      disabled: !!disabled,
		      value: v,
		      onChange: (e) => {
		        const next = e.target.value === '1' ? 'on' : e.target.value === '2' ? 'off' : 'inherit'
		        onChange(next)
		      }
		    },
		    h('option', { value: 0 }, labels.inherit),
		    h('option', { value: 1 }, labels.on),
		    h('option', { value: 2 }, labels.off)
		  )
		}

		function Card({ title, subtitle, actions, children }) {
		  return h(
		    'div',
		    { className: 'mcp-card' },
		    h(
		      'div',
		      { className: 'mcp-card-head' },
		      h('div', { className: 'mcp-card-title' }, title),
		      subtitle ? h('div', { className: 'mcp-card-sub' }, subtitle) : null,
		      actions ? h('div', { className: 'mcp-card-actions' }, actions) : null
		    ),
		    children
		  )
		}

		/* ============================== global section ============================== */

		function GlobalSection({ api, t, state, refresh }) {
		  const serverNames = Object.keys(state.live || {})
		  if (serverNames.length === 0) {
		    return h('div', { className: 'mcp-empty' }, t('noServers'))
		  }
		  return h(
		    'div',
		    { className: 'mcp-server-list' },
		    serverNames.map((server) => {
		      const entry = state.live[server]
		      const g = (state.global || {})[server] || { enabled: true, tools: {} }
		      const tools = entry.tools || []
		      return h(
		        'div',
		        { key: server, className: 'mcp-server' },
		        h(
		          'div',
		          { className: 'mcp-server-row' },
		          h('span', { className: 'mcp-dot ' + (entry.connected ? 'mcp-dot-on' : 'mcp-dot-off') }),
		          h('span', { className: 'mcp-server-name' }, server),
		          h(
		            'span',
		            { className: 'mcp-server-meta' },
		            entry.connected ? t('connected') : t('offline')
		          ),
		          h('span', { className: 'mcp-server-count' }, `${tools.length} ${t('toolsUnit')}`),
		          h(Toggle, {
		            checked: !!g.enabled,
		            onChange: (v) => api.setGlobalServer(server, v).then(refresh).catch((e) => console.error(e)),
		            title: t('globalServerToggle')
		          })
		        ),
		        h(
		          'div',
		          { className: 'mcp-tools' },
		          tools.map((tool) => {
		            const on = (g.tools || {})[tool.name] !== false
		            return h(
		              'div',
		              { key: tool.publicName || tool.name, className: 'mcp-tool-row' },
		              h('div', { className: 'mcp-tool-info' },
		                h('div', { className: 'mcp-tool-name' }, tool.name),
		                h('div', { className: 'mcp-tool-desc' }, tool.description || '')
		              ),
		              h(Toggle, {
		                checked: on,
		                disabled: !g.enabled,
		                onChange: (v) => api.setGlobalTool(server, tool.name, v).then(refresh).catch((e) => console.error(e)),
		                title: t('globalToolToggle')
		              })
		            )
		          })
		        )
		      )
		    })
		  )
		}

		/* ============================== workspace section ============================== */

		function WorkspaceSection({ api, t, state, workspaces, refresh }) {
		  const serverNames = Object.keys(state.live || {})
		  if (serverNames.length === 0) {
		    return h('div', { className: 'mcp-empty' }, t('noServers'))
		  }
		  if (!workspaces || workspaces.length === 0) {
		    return h('div', { className: 'mcp-empty' }, t('noWorkspaces'))
		  }
		  return h(
		    'div',
		    { className: 'mcp-workspace-list' },
		    workspaces.map((ws) => {
		      const overrides = ws.overrides || {}
		      const patchServer = (serverName, patch) =>
		        api.setWorkspace(ws.path, serverName, patch).then(refresh).catch((e) => console.error(e))
		      return h(
		        'div',
		        { key: ws.path, className: 'mcp-workspace' },
		        h(
		          'div',
		          { className: 'mcp-workspace-row' },
		          h('div', { className: 'mcp-workspace-info' },
		            h('div', { className: 'mcp-workspace-title' }, ws.title),
		            h('div', { className: 'mcp-workspace-path' }, ws.path)
		          ),
		          h(
		            'button',
		            {
		              type: 'button',
		              className: 'mcp-link-btn',
		              onClick: () => api.resetWorkspace(ws.path).then(refresh).catch((e) => console.error(e))
		            },
		            t('resetWorkspace')
		          )
		        ),
		        serverNames.map((server) => {
		          const ov = overrides[server] || { enabled: 'inherit', tools: {} }
		          const tools = (state.live[server] || {}).tools || []
		          return h(
		            'div',
		            { key: server, className: 'mcp-ws-server' },
		            h(
		              'div',
		              { className: 'mcp-ws-server-row' },
		              h('span', { className: 'mcp-server-name' }, server),
		              h(TriSelect, {
		                value: ov.enabled,
		                labels: t('tri'),
		                onChange: (v) => patchServer(server, { enabled: v })
		              })
		            ),
		            tools.length > 0
		              ? h(
		                  'div',
		                  { className: 'mcp-ws-tools' },
		                  tools.map((tool) =>
		                    h(
		                      'div',
		                      { key: tool.publicName || tool.name, className: 'mcp-tool-row mcp-ws-tool' },
		                      h('div', { className: 'mcp-tool-name' }, tool.name),
		                      h(TriSelect, {
		                        value: ov.tools[tool.name],
		                        labels: t('tri'),
		                        onChange: (v) => patchServer(server, { tool: tool.name, toolState: v })
		                      })
		                    )
		                  )
		                )
		              : null
		          )
		        })
		      )
		    })
		  )
		}

		/* ============================== server admin section ============================== */

		function emptyRow() {
		  return {
		    id: '',
		    serverName: '',
		    transport: 'stdio',
		    command: '',
		    args: [],
		    env: {},
		    cwd: '',
		    url: '',
		    headers: {},
		    toolCallTimeoutMs: 60000
		  }
		}

		function ServerAdmin({ api, t, state, refresh }) {
		  const [editing, setEditing] = React.useState(null) // null | row | 'new'
		  const [draft, setDraft] = React.useState(emptyRow())
		  const [error, setError] = React.useState('')
		  const [busy, setBusy] = React.useState(false)

		  const startNew = () => {
		    setDraft(emptyRow())
		    setEditing('new')
		    setError('')
		  }
		  const startEdit = (row) => {
		    setDraft({
		      id: row.id,
		      serverName: row.serverName,
		      transport: row.transport,
		      command: row.command,
		      args: row.args || [],
		      env: row.env || {},
		      cwd: row.cwd || '',
		      url: row.url || '',
		      headers: row.headers || {},
		      toolCallTimeoutMs: row.toolCallTimeoutMs || 60000
		    })
		    setEditing(row.id)
		    setError('')
		  }
		  const cancel = () => {
		    setEditing(null)
		    setError('')
		  }
		  const save = () => {
		    setBusy(true)
		    setError('')
		    api
		      .upsertServer(draft)
		      .then(() => {
		        setEditing(null)
		        refresh()
		      })
		      .catch((e) => setError(String(e && e.message ? e.message : e)))
		      .finally(() => setBusy(false))
		  }
		  const remove = (row) => {
		    if (!window.confirm(`${t('confirmRemove')} ${row.id}?`)) return
		    setBusy(true)
		    api
		      .removeServer(row.id)
		      .then(refresh)
		      .catch((e) => setError(String(e && e.message ? e.message : e)))
		      .finally(() => setBusy(false))
		  }

		  const field = (key, value, onChange, placeholder, type) =>
		    h('input', {
		      className: 'mcp-input',
		      value: value,
		      placeholder: placeholder || '',
		      type: type || 'text',
		      onChange: (e) => onChange(e.target.value)
		    })

		  return h('div', { className: 'mcp-admin' }, [
		    h(
		      'div',
		      { className: 'mcp-admin-hint' },
		      t('adminHint')
		    ),
		    h(
		      'div',
		      { className: 'mcp-admin-list' },
		      (state.servers || []).map((row) =>
		        h(
		          'div',
		          { key: row.id, className: 'mcp-admin-row' },
		          h('div', { className: 'mcp-admin-row-info' },
		            h('div', { className: 'mcp-admin-row-name' }, row.serverName || row.id),
		            h('div', { className: 'mcp-admin-row-meta' },
		              `${row.id} · ${row.transport}${row.transport === 'stdio' ? ' · ' + (row.command || '') : ' · ' + (row.url || '')}`
		            )
		          ),
		          h(
		            'button',
		            { type: 'button', className: 'mcp-btn', onClick: () => startEdit(row) },
		            t('edit')
		          ),
		          h(
		            'button',
		            { type: 'button', className: 'mcp-btn mcp-btn-danger', onClick: () => remove(row) },
		            t('remove')
		          )
		        )
		      )
		    ),
		    editing === null
		      ? h(
		          'button',
		          { type: 'button', className: 'mcp-btn mcp-btn-primary', onClick: startNew },
		          t('addServer')
		        )
		      : h('div', { className: 'mcp-form' }, [
		          h('div', { className: 'mcp-form-title' }, editing === 'new' ? t('addServer') : t('editServer')),
		          h('div', { className: 'mcp-form-row' }, [
		            h('label', { className: 'mcp-label' }, t('serverName')),
		            field('serverName', draft.serverName, (v) => setDraft({ ...draft, serverName: v }), 'dbx')
		          ]),
		          h('div', { className: 'mcp-form-row' }, [
		            h('label', { className: 'mcp-label' }, t('transport')),
		            h(
		              'select',
		              {
		                className: 'mcp-triselect',
		                value: draft.transport,
		                onChange: (e) => setDraft({ ...draft, transport: e.target.value })
		              },
		              h('option', { value: 'stdio' }, 'stdio'),
		              h('option', { value: 'streamable-http' }, 'streamable-http')
		            )
		          ]),
		          draft.transport === 'stdio'
		            ? [
		                h('div', { className: 'mcp-form-row' }, [
		                  h('label', { className: 'mcp-label' }, t('command')),
		                  field('command', draft.command, (v) => setDraft({ ...draft, command: v }), '/path/to/node')
		                ]),
		                h('div', { className: 'mcp-form-row' }, [
		                  h('label', { className: 'mcp-label' }, t('args')),
		                  field('args', (draft.args || []).join(' '), (v) =>
		                    setDraft({ ...draft, args: v.split(/\s+/).filter(Boolean) }), '--arg value')
		                ]),
		                h('div', { className: 'mcp-form-row' }, [
		                  h('label', { className: 'mcp-label' }, t('env')),
		                  field('env', Object.entries(draft.env || {}).map(([k, v]) => `${k}=${v}`).join(' '), (v) => {
		                    const env = {}
		                    for (const pair of v.split(/\s+/).filter(Boolean)) {
		                      const i = pair.indexOf('=')
		                      if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1)
		                    }
		                    setDraft({ ...draft, env })
		                  }, 'KEY=value')
		                ]),
		                h('div', { className: 'mcp-form-row' }, [
		                  h('label', { className: 'mcp-label' }, t('cwd')),
		                  field('cwd', draft.cwd || '', (v) => setDraft({ ...draft, cwd: v }), '')
		                ])
		              ]
		            : h('div', { className: 'mcp-form-row' }, [
		                h('label', { className: 'mcp-label' }, t('url')),
		                field('url', draft.url || '', (v) => setDraft({ ...draft, url: v }), 'https://...')
		              ]),
		          error ? h('div', { className: 'mcp-error' }, error) : null,
		          h('div', { className: 'mcp-form-actions' }, [
		            h('button', { type: 'button', className: 'mcp-btn mcp-btn-primary', disabled: busy, onClick: save }, t('save')),
		            h('button', { type: 'button', className: 'mcp-btn', onClick: cancel }, t('cancel'))
		          ])
		        ])
		  ])
		}

		/* ============================== section root ============================== */

		function McpManagerSection(props) {
		  const { api, t } = props
		  const useWorkspaces = props.useWorkspaces
		  const [state, setState] = React.useState(null)
		  const [error, setError] = React.useState('')
		  const [active, setActive] = React.useState('global')

		  const refresh = React.useCallback(() => {
		    api
		      .getState()
		      .then((s) => {
		        setState(s)
		        setError('')
		      })
		      .catch((e) => setError(String(e && e.message ? e.message : e)))
		  }, [api])

		  React.useEffect(() => {
		    refresh()
		    const dispose = api.onExternalChange ? api.onExternalChange(refresh) : undefined
		    return () => {
		      if (dispose) dispose()
		    }
		  }, [api, refresh])

		  const workspaceState = useWorkspaces ? useWorkspaces((state) => state) : null
		  const apiWorkspaces = (state && state.workspaces) || []
		  const apiOverrides = {}
		  for (const ws of apiWorkspaces) {
		    if (ws && typeof ws.path === 'string') apiOverrides[ws.path] = ws.overrides || {}
		  }
		  const workspaces = ((workspaceState && workspaceState.items) || []).map((item) => ({
		    path: item.path,
		    title: item.title || item.path,
		    overrides: apiOverrides[item.path] || {}
		  }))

		  const tabs = [
		    { id: 'global', label: t('tabGlobal') },
		    { id: 'workspace', label: t('tabWorkspace') },
		    { id: 'admin', label: t('tabAdmin') }
		  ]

		  return h('div', { className: 'mcp-manager' }, [
		    h(
		      'div',
		      { className: 'mcp-tabs' },
		      tabs.map((tab) =>
		        h(
		          'button',
		          {
		            key: tab.id,
		            type: 'button',
		            className: 'mcp-tab' + (active === tab.id ? ' mcp-tab-active' : ''),
		            onClick: () => setActive(tab.id)
		          },
		          tab.label
		        )
		      )
		    ),
		    error ? h('div', { className: 'mcp-error mcp-error-banner' }, error) : null,
		    h(
		      'div',
		      { className: 'mcp-body' },
		      state === null
		        ? h('div', { className: 'mcp-empty' }, t('loading'))
		        : active === 'global'
		          ? h(Card, { title: t('tabGlobal'), subtitle: t('globalHint') }, h(GlobalSection, { api, t, state, refresh }))
		          : active === 'workspace'
		            ? h(Card, { title: t('tabWorkspace'), subtitle: t('workspaceHint') }, h(WorkspaceSection, { api, t, state, workspaces, refresh }))
		            : h(Card, { title: t('tabAdmin'), subtitle: t('adminHint') }, h(ServerAdmin, { api, t, state, refresh }))
		    ),
		    state && state.debug
		      ? h('div', { className: 'mcp-debug-wrap' }, [
		          h('div', { className: 'mcp-debug-title' }, 'engine debug'),
		          h('pre', { className: 'mcp-debug' }, JSON.stringify(state.debug, null, 2))
		        ])
		      : null
		  ])
		}

		/* ============================== plugin ============================== */

		function buildClient(ReactModule, styles, createTransport, extraInject) {
		  const inject = ['slots', 'locale', ...(extraInject || [])]

		  function apply(ctx) {
		    if (styles && typeof styles.insert === 'function') {
		      try { styles.insert(getCSS()) } catch (e) { console.error('mcp-manager: styles insert failed', e) }
		    }
		    const locale = ctx.get('locale')
		    let t = (k) => getDicts().zh[k] || k
		    if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
		      try {
		        const D = getDicts()
		        ctx.effect(() => locale.register(NS, { zh: D.zh, en: D.en }), 'mcp-manager: locale')
		        t = locale.bind(NS)
		      } catch (e) {
		        console.error('mcp-manager: locale register failed', e)
		      }
		    }
		    const transport = createTransport(ctx)
		    const api = makeApi(transport)
		    const slots = ctx.get('slots')
		    if (slots === undefined) return
		    slots.inject(
		      'settings.section',
		      () =>
		        slots.register(
		          {
		            name: 'settings.section',
		            id: 'mcp-manager',
		            order: 30,
		            label: () => t('nav'),
		            inject: () => ({ api, t })
		          },
		          (props) => McpManagerSection({ ...props, api, t })
		        )
		    )
		  }

		  return { inject, apply }
		}

		/* ============================== dictionaries ============================== */
		// Function declarations (hoisted): the dynamic body returns the plugin FIRST,
		// so any const would sit in TDZ when apply() runs. getDicts/getCSS are callable
		// from the top-level return and from apply time.

		function getDicts() {
		  return {
		  zh: {
		    nav: 'MCP 管理',
		    tabGlobal: '全局设置',
		    tabWorkspace: '工作区设置',
		    tabAdmin: '服务器管理',
		    globalHint: '全局启用的开关；关闭后该 MCP 对所有工作区不可见',
		    workspaceHint: '工作区覆盖全局；留“继承”则跟随全局配置',
		    adminHint: '修改后需要重启 DSH 生效',
		    connected: '已连接',
		    offline: '未连接',
		    toolsUnit: '个工具',
		    noServers: '当前没有已连接/注册的 MCP 服务器',
		    noWorkspaces: '还没有工作区',
		    loading: '加载中…',
		    globalServerToggle: '全局启用/关闭该 MCP',
		    globalToolToggle: '全局启用/关闭该工具',
		    resetWorkspace: '重置为全局',
		    tri: { inherit: '继承全局', on: '启用', off: '关闭' },
		    addServer: '新增服务器',
		    editServer: '编辑服务器',
		    edit: '编辑',
		    remove: '删除',
		    save: '保存',
		    cancel: '取消',
		    serverName: 'serverName（标识）',
		    transport: '传输方式',
		    command: '启动命令',
		    args: '参数（空格分隔）',
		    env: '环境变量（KEY=value）',
		    cwd: '工作目录',
		    url: 'URL',
		    confirmRemove: '确认删除服务器',
		    restartHint: '重启后生效'
		  },
		  en: {
		    nav: 'MCP Manager',
		    tabGlobal: 'Global',
		    tabWorkspace: 'Workspaces',
		    tabAdmin: 'Servers',
		    globalHint: 'Global switches; disabling hides the MCP from every workspace',
		    workspaceHint: 'Workspace overrides global; "inherit" follows the global config',
		    adminHint: 'Changes take effect after restarting DSH',
		    connected: 'connected',
		    offline: 'offline',
		    toolsUnit: 'tools',
		    noServers: 'No connected or registered MCP servers',
		    noWorkspaces: 'No workspaces yet',
		    loading: 'Loading…',
		    globalServerToggle: 'Enable/disable this MCP globally',
		    globalToolToggle: 'Enable/disable this tool globally',
		    resetWorkspace: 'Reset to global',
		    tri: { inherit: 'Inherit global', on: 'On', off: 'Off' },
		    addServer: 'Add server',
		    editServer: 'Edit server',
		    edit: 'Edit',
		    remove: 'Remove',
		    save: 'Save',
		    cancel: 'Cancel',
		    serverName: 'serverName (id)',
		    transport: 'Transport',
		    command: 'Command',
		    args: 'Args (space separated)',
		    env: 'Env (KEY=value)',
		    cwd: 'Working dir',
		    url: 'URL',
		    confirmRemove: 'Remove server',
		    restartHint: 'Effective after restart'
		  }
		  }
		}

		/* ============================== styles ============================== */

		function getCSS() {
		  return `
		.mcp-manager{display:flex;flex-direction:column;gap:12px;width:100%;max-width:860px;margin:0 auto;padding:4px 8px 24px;color:var(--dsw-alias-label-primary, #1f2329)}
		.mcp-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.08));padding-bottom:8px}
		.mcp-tab{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary, #646a73);font-family:inherit;font-size:14px;line-height:22px;padding:6px 14px;border-radius:8px}
		.mcp-tab:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))}
		.mcp-tab-active{color:var(--dsw-alias-label-primary, #1f2329);background:var(--dsw-alias-interactive-bg-active, rgba(0,0,0,.08));font-weight:500}
		.mcp-body{display:flex;flex-direction:column;gap:12px}
		.mcp-card{border:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.08));border-radius:12px;background:var(--dsw-alias-bg-layer-1, #fff);overflow:hidden}
		.mcp-card-head{padding:14px 16px 8px;border-bottom:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.06))}
		.mcp-card-title{font-size:15px;font-weight:600}
		.mcp-card-sub{font-size:12px;color:var(--dsw-alias-label-secondary, #646a73);margin-top:2px}
		.mcp-empty{padding:20px 16px;color:var(--dsw-alias-label-secondary, #646a73);font-size:13px}
		.mcp-server,.mcp-workspace{border-bottom:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.05));padding:10px 16px}
		.mcp-server:last-child,.mcp-workspace:last-child{border-bottom:none}
		.mcp-server-row{display:flex;align-items:center;gap:10px}
		.mcp-dot{width:8px;height:8px;border-radius:50%;flex:none}
		.mcp-dot-on{background:#2fb344}
		.mcp-dot-off{background:#c9cdd4}
		.mcp-server-name{font-weight:600;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.mcp-server-meta{font-size:12px;color:var(--dsw-alias-label-secondary, #646a73)}
		.mcp-server-count{font-size:12px;color:var(--dsw-alias-label-secondary, #646a73);margin-right:auto}
		.mcp-toggle{box-sizing:border-box;width:36px;height:20px;border-radius:10px;border:none;background:var(--dsw-alias-bg-mask-2, rgba(0,0,0,.15));position:relative;cursor:pointer;flex:none;transition:background .15s}
		.mcp-toggle-on{background:#2f6bfe}
		.mcp-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
		.mcp-toggle-on .mcp-toggle-knob{left:18px}
		.mcp-tools{padding:6px 0 2px 18px}
		.mcp-tool-row{display:flex;align-items:center;gap:10px;padding:5px 0}
		.mcp-tool-info{flex:1;min-width:0}
		.mcp-tool-name{font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
		.mcp-tool-desc{font-size:11px;color:var(--dsw-alias-label-secondary, #646a73);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:520px}
		.mcp-triselect{border:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.15));border-radius:8px;background:var(--dsw-alias-bg-layer-2, #fafafa);color:var(--dsw-alias-label-primary, #1f2329);font-family:inherit;font-size:13px;padding:4px 8px;outline:none}
		.mcp-workspace-row{display:flex;align-items:center;gap:10px;margin-bottom:6px}
		.mcp-workspace-info{flex:1;min-width:0}
		.mcp-workspace-title{font-size:14px;font-weight:600}
		.mcp-workspace-path{font-size:11px;color:var(--dsw-alias-label-secondary, #646a73);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.mcp-link-btn{cursor:pointer;border:none;background:transparent;color:#2f6bfe;font-size:12px;font-family:inherit;padding:2px 6px;border-radius:6px}
		.mcp-link-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))}
		.mcp-ws-server{padding:6px 0 2px 18px;border-top:1px dashed var(--dsw-alias-line-color, rgba(0,0,0,.06))}
		.mcp-ws-server-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0}
		.mcp-ws-tools{padding-left:14px}
		.mcp-ws-tool .mcp-tool-name{flex:1}
		.mcp-admin{display:flex;flex-direction:column;gap:10px;padding:14px 16px}
		.mcp-admin-hint{font-size:12px;color:var(--dsw-alias-label-secondary, #646a73)}
		.mcp-admin-list{display:flex;flex-direction:column;gap:6px}
		.mcp-admin-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.08));border-radius:8px}
		.mcp-admin-row-info{flex:1;min-width:0}
		.mcp-admin-row-name{font-size:13px;font-weight:600}
		.mcp-admin-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary, #646a73);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.mcp-btn{cursor:pointer;border:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.15));border-radius:8px;background:var(--dsw-alias-bg-layer-2, #fafafa);color:var(--dsw-alias-label-primary, #1f2329);font-family:inherit;font-size:12px;padding:5px 12px}
		.mcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))}
		.mcp-btn-primary{border-color:#2f6bfe;background:#2f6bfe;color:#fff}
		.mcp-btn-primary:hover{background:#2659d8}
		.mcp-btn-danger{color:#d5484d;border-color:rgba(213,72,77,.4)}
		.mcp-form{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.12));border-radius:10px;padding:12px}
		.mcp-form-title{font-size:13px;font-weight:600}
		.mcp-form-row{display:flex;align-items:center;gap:10px}
		.mcp-label{width:150px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary, #646a73)}
		.mcp-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-line-color, rgba(0,0,0,.15));border-radius:8px;background:var(--dsw-alias-bg-layer-2, #fafafa);color:var(--dsw-alias-label-primary, #1f2329);font-family:inherit;font-size:13px;padding:6px 8px;outline:none}
		.mcp-input:focus{border-color:#2f6bfe}
		.mcp-form-actions{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
		.mcp-error{color:#d5484d;font-size:12px;padding:2px 4px}
		.mcp-error-banner{border:1px solid rgba(213,72,77,.3);background:rgba(213,72,77,.06);border-radius:8px;padding:8px 12px}
		.mcp-debug-wrap{border:1px dashed var(--dsw-alias-line-color, rgba(0,0,0,.15));border-radius:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02))}
		.mcp-debug-title{font-size:11px;color:var(--dsw-alias-label-secondary, #646a73);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:4px}
		.mcp-debug{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary, #646a73);white-space:pre-wrap;word-break:break-all;margin:0;max-height:220px;overflow:auto}
		`
		}



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


		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"dsh-mcp-manager\"]")) {
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

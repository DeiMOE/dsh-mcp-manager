# dsh-mcp-manager

DSH Web 的 MCP 管理插件：在设置面板中集中管理 MCP 服务器及其工具。

- **全局启用/关闭**：每个 MCP server 和每个工具都可以全局开关（默认开启）
- **工作区粒度**：每个工作区可以对 server / 工具设置三态覆盖（继承全局 / 启用 / 关闭），工作区优先于全局
- **服务器管理**：在设置面板中增删改 MCP 服务器（stdio / streamable-http），写入 profile 的 `cordis.patch.yml`
- **真实生效**：被关闭的工具通过 `tools.restrict` 从模型的可见工具清单中移除（不是只改 UI）

## 安装

把插件包放到 web profile 的 `node_modules` 下，并在 profile 的 `cordis.patch.yml` 挂载一行：

```bash
# 1. 复制包（以本仓库为例）
mkdir -p ~/.dsh/profiles/web/node_modules
cp -R dsh-mcp-manager ~/.dsh/profiles/web/node_modules/
```

```yaml
# 2. ~/.dsh/profiles/web/cordis.patch.yml 追加：
- insert:
    - id: mcp-manager
      name: 'dsh-mcp-manager'
```

```bash
# 3. 重启 dsh web
```

重启后，打开 **设置 → MCP 管理** 即可使用。

`install.sh` 自动化了 1–2 步（幂等）。

## 数据存储

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 全局开关 | `~/.dsh/settings.yaml`（`dsh-mcp-manager` 命名空间） | 通过宿主 settings 服务读写 |
| 工作区开关 | `<工作区>/.dsh/mcp.yml` | 工作区优先于全局 |
| 服务器定义 | `~/.dsh/profiles/web/cordis.patch.yml` | 增删改即时生效，重启后加载 |

工作区配置文件格式：

```yaml
servers:
  dbx:
    enabled: off          # inherit | on | off
    tools:
      dbx_execute_query: off
```

## HTTP API

客户端页面通过 `/api/mcp-manager/*` 与宿主通信（`webServer` prefix 路由）：

- `GET  /api/mcp-manager/state` — 服务器列表、实时工具清单、工作区覆盖、全局配置
- `POST /api/mcp-manager/global` — `{serverName, enabled?}` 或 `{serverName, tool, toolEnabled?}`
- `POST /api/mcp-manager/workspace` — `{path, serverName, enabled? | tool, toolState?}`（`toolState`: `inherit|on|off`）
- `POST /api/mcp-manager/workspace/reset` — `{path, serverName?}`（省略 serverName 时清空整个工作区）
- `POST /api/mcp-manager/server` — `{action: 'upsert'|'remove', ...}`（upsert 时行字段与 action 同级扁平传递）

## 开发

```bash
node build-client.mjs   # 由 src/client-core.js 生成 lib/client.js（客户端 bundle）
node test-host.mjs      # 宿主纯函数单测（28 项）
node lib/index.js       # 宿主插件（apply 入口）
```

### 结构

```
lib/index.js        宿主插件：settings 注册、限制引擎（tools.restrict）、HTTP API、patch CRUD
lib/client.js       客户端 bundle（由 src/client-core.js 构建，设置页 UI）
src/client-core.js  客户端 UI 源码（React，无 JSX/TS）
build-client.mjs    客户端构建脚本
test-host.mjs       宿主纯函数测试
cordis.patch.yml    示例挂载行（随包发布）
install.sh          安装脚本（复制 + 幂等挂载）
```

## 限制引擎说明

- 对每个存活 agent，按 agent 会话 cwd（工作区）计算生效配置：工作区 server 三态 > 工作区 tool 三态 > 全局 server > 全局 tool（默认开启）
- 通过 `tools.restrict` 在 agent 自身 scope 上施加过滤，`tools/change` 事件时重算
- 验证方式：关闭后从模型的工具清单中确认 `mcp__*` 工具消失

## License

MIT

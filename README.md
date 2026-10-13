# 功能台 · AI 开发功能管理

AI 开发过程中功能越堆越多、容易忘？功能台就是一个本地小站：**按项目记录功能**，
像一张电子表格一样管理每个项目的功能清单，随时看清完成度，
还能一键把清单复制成 Markdown 粘给 AI 会话。

## 启动

```bash
node server.js
```

然后浏览器打开 http://127.0.0.1:4173 （端口被占会自动向后找，以控制台打印的为准）。
零依赖，只需要 Node.js ≥ 16。

## 核心概念

- **项目（P-001…）**：右上角「＋ 新建项目」随时创建；左侧栏点击切换；重命名 / 删除在项目标题旁
- **功能（F-0001…）**：属于某个项目，在表格里一行一条，状态流转：想法 → 待开发 → 开发中 → 已完成（+ 已搁置）
- **项目完成度**：项目标题下方的彩色进度条 = 已完成 / (全部 − 已搁置)，侧栏每个项目旁也有百分比
- **功能完成度**：每个功能 0–100%，表格「完成度」列显示迷你进度条；编辑弹窗里用滑杆调节；
  状态联动——点「完成」自动 100%，从已完成重开自动归 0，其余时候保持手动值

## 数据在哪

所有数据存在 `data/features.json`，按项目分组：

```json
{
  "seq": 9,
  "pseq": 3,
  "active": "P-001",
  "projects": [
    {
      "id": "P-001",
      "name": "默认项目",
      "desc": "由旧版数据自动迁移而来。",
      "createdAt": "2026-10-11T00:00:00.000Z",
      "features": [
        {
          "id": "F-0002",
          "title": "状态流水线统计条",
          "desc": "顶部按状态占比分段的彩色统计条……",
          "module": "界面",
          "status": "doing",
          "priority": "high",
          "progress": 60,
          "tags": ["可视化"],
          "createdAt": "…",
          "updatedAt": "…"
        }
      ]
    }
  ]
}
```

**和 AI 协作的关键**：让 AI 直接读这个文件就能掌握所有项目的功能全貌；也可以点侧栏底部「复制 Markdown」，
把当前项目的清单粘进会话，AI 就不会忘记还有哪些功能没做。旧版无项目结构的数据会在启动时自动迁移。

## 页面操作

- 右上角「＋ 新建项目」创建项目，创建后自动切换过去
- 左侧导航栏：项目列表（含完成度）、功能状态、模块（都带数量），点击筛选 / 切换，再点一次取消
- 主区顶部的彩色概览条：各状态数量占比一览，点击同样可以筛选
- 功能列表按状态**分层分区**展示：开发中 → 待开发 → 想法 → 已搁置 → 已完成，
  每个区块有自己的彩色标题条和计数（正在做的在最上面，已完成的沉底）；筛选时只显示匹配的区块
- 表格每行的第一个按钮随状态变化：立项 → 开始 → 完成 → 重开；搁置的功能点「恢复」
- 搜索支持标题 / 描述 / 标签 / 编号，按 `/` 快速聚焦
- 删除功能、删除项目都是连点两次（第一次是确认；删项目会连同其功能一起删除）
- 小屏幕下侧栏收起，点左上角 ☰ 按钮抽出

## 给 AI 用：MCP 服务

`mcp-server.js` 是零依赖的 stdio MCP 服务，把功能台暴露成 AI 可调用的工具，
与 HTTP 服务共用 `lib/store.js` 数据层（校验规则、状态/完成度联动完全一致）。

### 块一：MCP 提供的工具

| 工具 | 说明 |
| --- | --- |
| `list_projects` | 所有项目 + 完成度 |
| `list_features` | 功能清单（可按项目 / 状态过滤） |
| `get_feature` | 单个功能详情 |
| `create_feature` / `update_feature` / `delete_feature` | 功能增删改 |
| `advance_feature` | 推进状态一步（完成度自动联动） |
| `create_project` / `delete_project` | 项目增删 |
| `export_markdown` | 导出 Markdown 清单（全部或单项目） |

AI 的推荐用法：开工前 `list_features` 看待办 → 领取一项置开发中 → 完成后 `advance_feature` 或置 done → 需要全貌时 `export_markdown`。

### 块二：怎么连接

MCP 服务通过 **stdio 传输**工作：客户端拉起 `node D:/kaifamanager/mcp-server.js` 子进程，
用 stdin/stdout 上的 JSON-RPC 通信。零依赖、无需先启动 `server.js`（数据层直接读写 `data/features.json`）。

**ZCode**（本仓库已配好工作区级，重开会话即生效）

```json
// 工作区级：<项目根>/.zcode/config.json（仅本项目，随仓库走，注意路径按机器修改）
{
  "mcp": {
    "servers": {
      "feature-board": {
        "command": "node",
        "args": ["D:/kaifamanager/mcp-server.js"]
      }
    }
  }
}
```

用户级（所有项目生效）则写在 `~/.zcode/cli/config.json` 的同一位置 `mcp.servers`。
也可以在客户端图形界面 **Settings → MCP** 里添加。配置后新会话自动连接，工具以
`mcp__feature-board__list_features` 这类名字出现。

**Claude Code**

```bash
claude mcp add feature-board -- node D:/kaifamanager/mcp-server.js
```

或直接编辑项目根的 `.mcp.json`（团队共享）：

```json
{
  "mcpServers": {
    "feature-board": { "command": "node", "args": ["D:/kaifamanager/mcp-server.js"] }
  }
}
```

**Cursor 及其他支持 stdio MCP 的客户端**

`.cursor/mcp.json`（Cursor）或对应客户端的 MCP 配置，格式同为上面的 `mcpServers` 结构，
命令一律是 `node D:/kaifamanager/mcp-server.js`。

**验证是否连上**

```bash
# 手动模拟一次 MCP 握手：能看到 feature-board 0.1.0 和工具列表即正常
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | node mcp-server.js
```

连上后在客户端里问一句「看下功能台有哪些待开发功能」，AI 能调出清单就说明通了。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/workspace` | 全量数据（含项目层） |
| POST | `/api/projects` | 新建项目 `{"name": "...", "desc": "..."}` |
| PATCH | `/api/projects/P-001` | 重命名 / 改说明 / `{"active": true}` 记住当前项目 |
| DELETE | `/api/projects/P-001` | 删除项目（连同功能） |
| POST | `/api/projects/P-001/features` | 在项目下新增功能 |
| PATCH | `/api/features/F-0002` | 修改功能任意字段 |
| DELETE | `/api/features/F-0002` | 删除功能 |
| GET | `/api/export.md` | 导出全部项目的 Markdown 清单 |

状态取值：`idea / todo / doing / done / shelved`；优先级：`high / mid / low`。

## 目录结构

```
kaifamanager/
├── server.js           # 零依赖 HTTP 服务（静态文件 + API + 热更新）
├── mcp-server.js       # stdio MCP 服务（AI 工具）
├── lib/
│   └── store.js        # 共享数据层（校验 + 状态/完成度联动）
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── data/
    └── features.json   # 全部数据（自动创建，旧格式自动迁移）
```

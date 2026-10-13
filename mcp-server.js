#!/usr/bin/env node
'use strict';
/* 功能台 MCP 服务 —— 把功能台暴露成 AI 可调用的工具（stdio 传输，零依赖）。
   与 HTTP 服务共用 lib/store.js 数据层，校验规则与状态/完成度联动完全一致。
   注意：stdout 只输出 JSON-RPC 消息，诊断信息一律走 stderr。 */

const readline = require('readline');
const store = require('./lib/store');

const SERVER_INFO = { name: 'feature-board', version: '0.1.0' };

const STATUS_ENUM = ['idea', 'todo', 'doing', 'done', 'shelved'];
const PRIORITY_ENUM = ['high', 'mid', 'low'];

/* ---------- 工具定义 ---------- */

const TOOLS = [
  {
    name: 'list_projects',
    description: '列出功能台的所有项目：编号、名称、功能数量、完成度。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_features',
    description: '列出功能清单（默认当前项目）。status 取值：idea=想法, todo=待开发, doing=开发中, done=已完成, shelved=已搁置。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目编号（如 P-001）或名称；缺省为当前项目' },
        status: { type: 'string', enum: STATUS_ENUM, description: '按状态过滤，缺省为全部' },
      },
    },
  },
  {
    name: 'get_feature',
    description: '查看单个功能的完整详情。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '功能编号，如 F-0013' } },
      required: ['id'],
    },
  },
  {
    name: 'create_feature',
    description: '在项目中录入一个新功能。开发中随手记录想法时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目编号或名称；缺省为当前项目' },
        title: { type: 'string', description: '功能标题（必填）' },
        desc: { type: 'string', description: '功能描述 / 验收标准' },
        module: { type: 'string', description: '所属模块，如 账号 / 支付' },
        status: { type: 'string', enum: STATUS_ENUM, description: '初始状态，缺省 todo' },
        priority: { type: 'string', enum: PRIORITY_ENUM, description: '优先级，缺省 mid' },
        progress: { type: 'number', description: '完成度 0-100，缺省按状态推算' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 8 个' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_feature',
    description: '修改功能的任意字段。状态改为 done 时完成度自动置 100，从 done 改回其他状态自动归 0（显式给 progress 时以显式值为准）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '功能编号' },
        title: { type: 'string' }, desc: { type: 'string' }, module: { type: 'string' },
        status: { type: 'string', enum: STATUS_ENUM },
        priority: { type: 'string', enum: PRIORITY_ENUM },
        progress: { type: 'number', description: '完成度 0-100' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'advance_feature',
    description: '推进功能状态一步：想法→待开发→开发中→已完成；已完成或已搁置的回到待开发。完成度随状态联动。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '功能编号' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_feature',
    description: '删除一个功能（不可恢复）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '功能编号' } },
      required: ['id'],
    },
  },
  {
    name: 'create_project',
    description: '创建一个新项目（创建后成为当前项目）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '项目名（必填）' },
        desc: { type: 'string', description: '一句话说明' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_project',
    description: '删除项目及其全部功能（不可恢复）。删之前建议先 export_markdown 留档。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: '项目编号或名称' } },
      required: ['project'],
    },
  },
  {
    name: 'export_markdown',
    description: '导出 Markdown 功能清单。粘进 AI 会话可让 AI 掌握功能全貌，也可作为存档。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目编号或名称；缺省导出全部项目' },
      },
    },
  },
];

/* ---------- 工具实现 ---------- */

function fmtFeature(f) {
  const tags = f.tags && f.tags.length ? ' ｜ #' + f.tags.join(' #') : '';
  return f.id + ' ' + f.title +
    ' ｜ ' + store.STATUS_LABEL[f.status] +
    ' ｜ 优先级:' + (store.PRIORITY_LABEL[f.priority] || '中') +
    ' ｜ 完成:' + store.progressOf(f) + '%' +
    ' ｜ 模块:' + (f.module || '未分类') + tags;
}

function text(t) {
  return { content: [{ type: 'text', text: String(t) }] };
}

function callTool(name, args) {
  const db = store.loadDb();
  args = args || {};

  switch (name) {
    case 'list_projects': {
      if (!db.projects.length) return text('还没有项目，可用 create_project 创建。');
      const lines = db.projects.map((p) => {
        const c = store.completion(p);
        const pct = c.pct === null ? '—' : c.pct + '%';
        return p.id + ' ' + p.name + ' · ' + c.total + ' 项功能 · 完成 ' + c.done + '/' + c.planned + '（' + pct + '）' +
          (p.id === db.active ? ' · 当前项目' : '') + (p.desc ? '\n  ' + p.desc : '');
      });
      return text(lines.join('\n'));
    }

    case 'list_features': {
      const p = store.resolveProject(db, args.project);
      if (!p) throw new Error('找不到项目：' + (args.project || '（当前没有激活项目）'));
      const feats = args.status ? p.features.filter((f) => f.status === args.status) : p.features;
      const head = '项目：' + p.id + ' ' + p.name +
        (args.status ? '（' + store.STATUS_LABEL[args.status] + ' ' + feats.length + ' 项）' : '（共 ' + p.features.length + ' 项）');
      return text(head + '\n' + (feats.map(fmtFeature).join('\n') || '（空）'));
    }

    case 'get_feature': {
      const hit = store.findFeature(db, args.id);
      if (!hit) throw new Error('功能不存在：' + args.id);
      return text(fmtFeature(hit.feature) + '\n所属项目：' + hit.project.id + ' ' + hit.project.name +
        '\n描述：' + (hit.feature.desc || '（无）') +
        '\n创建：' + hit.feature.createdAt + ' ｜ 更新：' + hit.feature.updatedAt);
    }

    case 'create_feature': {
      const p = store.resolveProject(db, args.project);
      if (!p) throw new Error('找不到项目：' + (args.project || '（当前没有激活项目）'));
      const f = store.createFeature(db, p.id, args);
      store.saveDb(db);
      return text('已在 ' + p.name + ' 创建：' + fmtFeature(f));
    }

    case 'update_feature': {
      const f = store.patchFeature(db, args.id, args);
      store.saveDb(db);
      return text('已更新：' + fmtFeature(f));
    }

    case 'advance_feature': {
      const hit = store.findFeature(db, args.id);
      if (!hit) throw new Error('功能不存在：' + args.id);
      const from = hit.feature.status;
      const to = store.STATUS_NEXT[from];
      const f = store.patchFeature(db, args.id, { status: to });
      store.saveDb(db);
      return text('已推进：' + f.id + ' ' + f.title + ' ｜ ' + store.STATUS_LABEL[from] + ' → ' + store.STATUS_LABEL[to] + ' ｜ 完成:' + store.progressOf(f) + '%');
    }

    case 'delete_feature': {
      const ok = store.deleteFeature(db, args.id);
      if (!ok) throw new Error('功能不存在：' + args.id);
      store.saveDb(db);
      return text('已删除功能 ' + args.id);
    }

    case 'create_project': {
      const p = store.createProject(db, args);
      store.saveDb(db);
      return text('已创建项目：' + p.id + ' ' + p.name + '（已设为当前项目）');
    }

    case 'delete_project': {
      const p = store.resolveProject(db, args.project);
      if (!p) throw new Error('找不到项目：' + args.project);
      store.deleteProject(db, p.id);
      store.saveDb(db);
      return text('已删除项目 ' + p.id + ' ' + p.name + '（含其全部功能）');
    }

    case 'export_markdown': {
      if (args.project) {
        const p = store.resolveProject(db, args.project);
        if (!p) throw new Error('找不到项目：' + args.project);
        return text(store.exportProjectMarkdown(p));
      }
      return text(store.exportMarkdown(db));
    }

    default:
      throw new Error('未知工具：' + name);
  }
}

/* ---------- MCP 协议（stdio，按行分帧的 JSON-RPC 2.0） ---------- */

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 无法解析的行直接忽略
  }
  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    } else if (method === 'notifications/initialized') {
      // 通知，无需应答
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const r = callTool(params.name, params.arguments);
      reply(id, r);
    } else if (method === 'ping') {
      reply(id, {});
    } else if (id !== undefined) {
      replyError(id, -32601, 'Method not found: ' + method);
    }
    // 其余通知（cancelled 等）忽略
  } catch (err) {
    if (id !== undefined) {
      reply(id, { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true });
    }
  }
});

rl.on('close', () => process.exit(0));

process.stderr.write('feature-board MCP server ready (stdio)\n');

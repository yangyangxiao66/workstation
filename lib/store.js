'use strict';
/* 功能台数据层：HTTP 服务（server.js）与 MCP 服务（mcp-server.js）共用。
   所有写入走这里，保证校验规则和状态/完成度联动只有一份实现。 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'features.json');

const STATUSES = new Set(['idea', 'todo', 'doing', 'done', 'shelved']);
const PRIORITIES = new Set(['high', 'mid', 'low']);
const STATUS_LABEL = { idea: '想法', todo: '待开发', doing: '开发中', done: '已完成', shelved: '已搁置' };
const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };
// 状态推进方向（advance 用）
const STATUS_NEXT = { idea: 'todo', todo: 'doing', doing: 'done', done: 'todo', shelved: 'todo' };
// 导出时的分组顺序：先看正在做的，最后看已完成的
const MD_ORDER = ['doing', 'todo', 'idea', 'shelved', 'done'];

/* ---------- 读写与迁移 ---------- */

function seedDb() {
  const now = Date.now();
  const ago = (days) => new Date(now - days * 86400000).toISOString();
  return {
    seq: 4,     // 功能编号计数（全局唯一）
    pseq: 1,    // 项目编号计数
    active: 'P-001', // 上次操作的项目
    projects: [
      {
        id: 'P-001',
        name: '示例项目',
        desc: '功能台自带的示例，可重命名或删除，再创建你自己的项目。',
        createdAt: ago(6),
        features: [
          {
            id: 'F-0001',
            title: '功能增删改查',
            desc: '录入、编辑、删除功能项；数据实时落盘到 data/features.json，人和 AI 都能直接读写这份文件。',
            module: '核心',
            status: 'done',
            priority: 'high',
            progress: 100,
            tags: ['crud'],
            createdAt: ago(6),
            updatedAt: ago(2),
          },
          {
            id: 'F-0002',
            title: '状态流水线统计条',
            desc: '顶部按状态分段展示各状态数量，点击任意段即可筛选该状态的功能。',
            module: '界面',
            status: 'doing',
            priority: 'high',
            progress: 60,
            tags: ['可视化'],
            createdAt: ago(5),
            updatedAt: ago(0.2),
          },
          {
            id: 'F-0003',
            title: '一键复制 Markdown 清单',
            desc: '把当前功能清单整理成 Markdown 复制到剪贴板，开发时直接粘给 AI 会话，防止它忘记还有哪些功能。',
            module: 'AI 协作',
            status: 'todo',
            priority: 'mid',
            progress: 0,
            tags: ['导出'],
            createdAt: ago(3),
            updatedAt: ago(1),
          },
          {
            id: 'F-0004',
            title: 'MCP 服务',
            desc: '把功能台暴露成 AI 可调用的工具：查清单、录功能、推进状态。',
            module: 'AI 协作',
            status: 'todo',
            priority: 'high',
            progress: 0,
            tags: ['mcp'],
            createdAt: ago(1),
            updatedAt: ago(1),
          },
        ],
      },
    ],
  };
}

function loadDb() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    const db = seedDb(); // 首次运行或文件不可读时重建
    saveDb(db);
    return db;
  }

  // 新版结构
  if (Array.isArray(raw.projects) && typeof raw.pseq === 'number') {
    if (typeof raw.seq !== 'number') raw.seq = 0;
    for (const p of raw.projects) if (!Array.isArray(p.features)) p.features = [];
    return raw;
  }

  // 旧版结构（无项目层）→ 自动迁移进默认项目
  if (Array.isArray(raw.features)) {
    const db = {
      seq: typeof raw.seq === 'number' ? raw.seq : raw.features.length,
      pseq: 1,
      active: 'P-001',
      projects: [
        {
          id: 'P-001',
          name: '默认项目',
          desc: '由旧版数据自动迁移而来。',
          createdAt: new Date().toISOString(),
          features: raw.features,
        },
      ],
    };
    saveDb(db);
    return db;
  }

  const db = seedDb();
  saveDb(db);
  return db;
}

// 先写临时文件再改名，避免写一半产生坏文件
function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- 校验与工具 ---------- */

// 去首尾空白，超长截断；空字符串返回 undefined
function str(v, max) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().slice(0, 30))
    .filter(Boolean)
    .slice(0, 8);
}

// 完成度取整并夹在 0-100；非法输入返回 undefined（表示未提供）
function clampProgress(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function newFeatureId(seq) {
  return 'F-' + String(seq).padStart(4, '0');
}

function newProjectId(seq) {
  return 'P-' + String(seq).padStart(3, '0');
}

// 按编号或名称解析项目；ref 为空时取当前项目，再退到第一个
function resolveProject(db, ref) {
  if (ref) {
    return db.projects.find((p) => p.id === ref) ||
      db.projects.find((p) => p.name === ref) || null;
  }
  return db.projects.find((p) => p.id === db.active) || db.projects[0] || null;
}

function findFeature(db, id) {
  for (const p of db.projects) {
    const f = p.features.find((x) => x.id === id);
    if (f) return { project: p, feature: f };
  }
  return null;
}

// 完成度读取：无记录值时按状态回退（完成=100，其余=0）
function progressOf(f) {
  if (typeof f.progress === 'number' && Number.isFinite(f.progress)) {
    return Math.max(0, Math.min(100, Math.round(f.progress)));
  }
  return f.status === 'done' ? 100 : 0;
}

// 项目完成度：已完成 / (全部 - 已搁置)；全部搁置或无功能时 pct 为 null
function completion(p) {
  const total = p.features.length;
  const shelved = p.features.filter((f) => f.status === 'shelved').length;
  const done = p.features.filter((f) => f.status === 'done').length;
  const planned = total - shelved;
  return { total, done, shelved, planned, pct: planned > 0 ? Math.round((done / planned) * 100) : null };
}

/* ---------- 项目操作（参数不合法直接抛错） ---------- */

function createProject(db, body) {
  const name = str(body.name, 100);
  if (!name) throw new Error('项目名不能为空');
  db.pseq += 1;
  const p = {
    id: newProjectId(db.pseq),
    name,
    desc: str(body.desc, 500) || '',
    createdAt: new Date().toISOString(),
    features: [],
  };
  db.projects.push(p);
  db.active = p.id; // 新建后直接切换过去
  return p;
}

function updateProject(db, pid, body) {
  const p = db.projects.find((x) => x.id === pid);
  if (!p) return null;
  if ('name' in body) {
    const name = str(body.name, 100);
    if (!name) throw new Error('项目名不能为空');
    p.name = name;
  }
  if ('desc' in body) p.desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, 500) : '';
  if (body.active === true) db.active = pid; // 记住当前操作的项目
  return p;
}

function deleteProject(db, pid) {
  const before = db.projects.length;
  db.projects = db.projects.filter((x) => x.id !== pid);
  if (db.projects.length === before) return false;
  if (db.active === pid) db.active = db.projects[0] ? db.projects[0].id : null;
  return true;
}

/* ---------- 功能操作 ---------- */

function createFeature(db, pid, body) {
  const p = db.projects.find((x) => x.id === pid);
  if (!p) throw new Error('项目不存在');

  const title = str(body.title, 200);
  if (!title) throw new Error('标题不能为空');

  const now = new Date().toISOString();
  db.seq += 1;
  const status = STATUSES.has(body.status) ? body.status : 'todo';
  const prog = clampProgress(body.progress);
  const f = {
    id: newFeatureId(db.seq),
    title,
    desc: typeof body.desc === 'string' ? body.desc.trim().slice(0, 5000) : '',
    module: str(body.module, 50) || '',
    status,
    priority: PRIORITIES.has(body.priority) ? body.priority : 'mid',
    progress: prog !== undefined ? prog : (status === 'done' ? 100 : 0),
    tags: cleanTags(body.tags),
    createdAt: now,
    updatedAt: now,
  };
  p.features.push(f);
  return f;
}

function patchFeature(db, fid, body) {
  const hit = findFeature(db, fid);
  if (!hit) throw new Error('功能不存在');
  const f = hit.feature;

  const patch = {};
  if ('title' in body) {
    const t = str(body.title, 200);
    if (!t) throw new Error('标题不能为空');
    patch.title = t;
  }
  if ('desc' in body) {
    patch.desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, 5000) : '';
  }
  if ('module' in body) patch.module = str(body.module, 50) || '';
  if ('status' in body) {
    if (!STATUSES.has(body.status)) throw new Error('无效的状态');
    patch.status = body.status;
  }
  if ('priority' in body) {
    if (!PRIORITIES.has(body.priority)) throw new Error('无效的优先级');
    patch.priority = body.priority;
  }
  if ('tags' in body) patch.tags = cleanTags(body.tags);
  if ('progress' in body) {
    const prog = clampProgress(body.progress);
    if (prog !== undefined) patch.progress = prog;
  }
  if (!Object.keys(patch).length) return f;

  const oldStatus = f.status;
  Object.assign(f, patch, { updatedAt: new Date().toISOString() });
  // 状态与完成度联动：未显式给完成度时，完成=100%，从完成重开=0%
  if (patch.progress === undefined) {
    if (f.status === 'done' && oldStatus !== 'done') f.progress = 100;
    else if (oldStatus === 'done' && ['todo', 'idea', 'doing'].includes(f.status)) f.progress = 0;
  }
  return f;
}

function deleteFeature(db, fid) {
  const hit = findFeature(db, fid);
  if (!hit) return false;
  hit.project.features = hit.project.features.filter((x) => x.id !== fid);
  return true;
}

/* ---------- 导出 ---------- */

function exportProjectMarkdown(p) {
  const c = completion(p);
  const pct = c.pct === null ? '—' : c.pct + '%';
  const lines = ['# ' + p.name + '（完成 ' + c.done + '/' + c.planned + ' · ' + pct + '）', ''];
  if (p.desc) lines.push('> ' + p.desc, '');
  for (const st of MD_ORDER) {
    const group = p.features.filter((f) => f.status === st);
    if (!group.length) continue;
    lines.push('## ' + STATUS_LABEL[st] + '（' + group.length + '）', '');
    for (const f of group) {
      const tags = f.tags && f.tags.length ? ' ｜ ' + f.tags.map((t) => '#' + t).join(' ') : '';
      lines.push(
        '- **' + f.id + ' ' + f.title + '** ｜ 模块:' + (f.module || '未分类') +
        ' ｜ 优先级:' + (PRIORITY_LABEL[f.priority] || '中') + ' ｜ 完成:' + progressOf(f) + '%' + tags
      );
      if (f.desc) lines.push('  ' + f.desc.replace(/\r?\n/g, ' '));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function exportMarkdown(db) {
  const parts = ['# 功能清单（按项目）', ''];
  for (const p of db.projects) parts.push(exportProjectMarkdown(p));
  return parts.join('\n').trim() + '\n';
}

module.exports = {
  DATA_FILE,
  STATUSES, PRIORITIES, STATUS_LABEL, PRIORITY_LABEL, STATUS_NEXT, MD_ORDER,
  loadDb, saveDb, seedDb,
  str, cleanTags, clampProgress,
  newFeatureId, newProjectId, resolveProject, findFeature, progressOf, completion,
  createProject, updateProject, deleteProject,
  createFeature, patchFeature, deleteFeature,
  exportProjectMarkdown, exportMarkdown,
};

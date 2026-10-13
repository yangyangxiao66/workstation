#!/usr/bin/env node
/* 功能台 —— 按项目记录功能的管理小站（零依赖，node server.js 即可启动） */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'features.json');

const STATUSES = new Set(['idea', 'todo', 'doing', 'done', 'shelved']);
const PRIORITIES = new Set(['high', 'mid', 'low']);
const STATUS_LABEL = { idea: '想法', todo: '待开发', doing: '开发中', done: '已完成', shelved: '已搁置' };
const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };
// 导出时的分组顺序：先看正在做的，最后看已完成的
const MD_ORDER = ['doing', 'todo', 'idea', 'shelved', 'done'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------- 数据层 ---------- */

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
            tags: ['crud'],
            createdAt: ago(6),
            updatedAt: ago(2),
          },
          {
            id: 'F-0002',
            title: '状态流水线统计条',
            desc: '顶部按状态占比分段的彩色统计条，点击任意段落即可筛选该状态的功能。',
            module: '界面',
            status: 'doing',
            priority: 'high',
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
            tags: ['导出'],
            createdAt: ago(3),
            updatedAt: ago(1),
          },
          {
            id: 'F-0004',
            title: '多项目空间',
            desc: '支持多个项目各自独立的功能空间与切换。',
            module: '扩展',
            status: 'idea',
            priority: 'low',
            tags: ['远期'],
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

/* ---------- 工具 ---------- */

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

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

function newFeatureId(seq) {
  return 'F-' + String(seq).padStart(4, '0');
}

function newProjectId(seq) {
  return 'P-' + String(seq).padStart(3, '0');
}

// 完成度取整并夹在 0-100；非法输入返回 undefined（表示未提供）
function clampProgress(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function findFeature(db, id) {
  for (const p of db.projects) {
    const f = p.features.find((x) => x.id === id);
    if (f) return { project: p, feature: f };
  }
  return null;
}

function exportMarkdown(db) {
  const lines = ['# 功能清单（按项目）', '', `> 更新于 ${new Date().toLocaleString('zh-CN')} ｜ 共 ${db.projects.length} 个项目`, ''];
  for (const p of db.projects) {
    const total = p.features.length;
    const done = p.features.filter((f) => f.status === 'done').length;
    lines.push(`# ${p.name}（${done}/${total} 完成）`, '');
    if (p.desc) lines.push('> ' + p.desc, '');
    for (const st of MD_ORDER) {
      const group = p.features.filter((f) => f.status === st);
      if (!group.length) continue;
      lines.push(`## ${STATUS_LABEL[st]}（${group.length}）`, '');
      for (const f of group) {
        const tags = f.tags && f.tags.length ? ' ｜ ' + f.tags.map((t) => `#${t}`).join(' ') : '';
        lines.push(
          `- **${f.id} ${f.title}** ｜ 模块:${f.module || '未分类'} ｜ 优先级:${PRIORITY_LABEL[f.priority] || '中'}${tags}`
        );
        if (f.desc) lines.push('  ' + f.desc.replace(/\r?\n/g, ' '));
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/* ---------- API ---------- */

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/workspace') {
    return sendJson(res, 200, loadDb());
  }

  if (req.method === 'GET' && pathname === '/api/export.md') {
    const md = exportMarkdown(loadDb());
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(md);
  }

  /* ----- 项目 ----- */

  if (req.method === 'POST' && pathname === '/api/projects') {
    const body = await readBody(req);
    const name = str(body.name, 100);
    if (!name) return sendJson(res, 400, { error: '项目名不能为空' });
    const db = loadDb();
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
    saveDb(db);
    return sendJson(res, 201, p);
  }

  let m = pathname.match(/^\/api\/projects\/(P-\d{3,})$/);
  if (m) {
    const pid = m[1];
    const db = loadDb();
    const p = db.projects.find((x) => x.id === pid);
    if (!p) return sendJson(res, 404, { error: '项目不存在' });

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if ('name' in body) {
        const name = str(body.name, 100);
        if (!name) return sendJson(res, 400, { error: '项目名不能为空' });
        p.name = name;
      }
      if ('desc' in body) p.desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, 500) : '';
      if (body.active === true) db.active = pid; // 记住当前操作的项目
      saveDb(db);
      return sendJson(res, 200, p);
    }

    if (req.method === 'DELETE') {
      db.projects = db.projects.filter((x) => x.id !== pid);
      if (db.active === pid) db.active = db.projects[0] ? db.projects[0].id : null;
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  /* ----- 项目下的功能 ----- */

  m = pathname.match(/^\/api\/projects\/(P-\d{3,})\/features$/);
  if (m && req.method === 'POST') {
    const db = loadDb();
    const p = db.projects.find((x) => x.id === m[1]);
    if (!p) return sendJson(res, 404, { error: '项目不存在' });

    const body = await readBody(req);
    const title = str(body.title, 200);
    if (!title) return sendJson(res, 400, { error: '标题不能为空' });

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
    saveDb(db);
    return sendJson(res, 201, f);
  }

  /* ----- 功能（跨项目按编号定位） ----- */

  m = pathname.match(/^\/api\/features\/(F-\d{4,})$/);
  if (m) {
    const id = m[1];
    const db = loadDb();
    const hit = findFeature(db, id);
    if (!hit) return sendJson(res, 404, { error: '功能不存在' });
    const f = hit.feature;

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if ('title' in body) {
        const t = str(body.title, 200);
        if (!t) return sendJson(res, 400, { error: '标题不能为空' });
        patch.title = t;
      }
      if ('desc' in body) {
        patch.desc = typeof body.desc === 'string' ? body.desc.trim().slice(0, 5000) : '';
      }
      if ('module' in body) patch.module = str(body.module, 50) || '';
      if ('status' in body) {
        if (!STATUSES.has(body.status)) return sendJson(res, 400, { error: '无效的状态' });
        patch.status = body.status;
      }
      if ('priority' in body) {
        if (!PRIORITIES.has(body.priority)) return sendJson(res, 400, { error: '无效的优先级' });
        patch.priority = body.priority;
      }
      if ('tags' in body) patch.tags = cleanTags(body.tags);
      if ('progress' in body) {
        const prog = clampProgress(body.progress);
        if (prog !== undefined) patch.progress = prog;
      }
      if (!Object.keys(patch).length) return sendJson(res, 200, f);

      const oldStatus = f.status;
      Object.assign(f, patch, { updatedAt: new Date().toISOString() });
      // 状态与完成度联动：未显式给完成度时，完成=100%，从完成重开=0%
      if (patch.progress === undefined) {
        if (f.status === 'done' && oldStatus !== 'done') f.progress = 100;
        else if (oldStatus === 'done' && ['todo', 'idea', 'doing'].includes(f.status)) f.progress = 0;
      }
      saveDb(db);
      return sendJson(res, 200, f);
    }

    if (req.method === 'DELETE') {
      hit.project.features = hit.project.features.filter((x) => x.id !== id);
      saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ---------- 热更新：public/ 文件变化时通知页面自动刷新 ---------- */

const hotClients = new Set();

try {
  fs.watch(PUBLIC_DIR, { recursive: true }, () => {
    for (const res of hotClients) {
      try { res.write('data: reload\n\n'); } catch { /* 连接已断开，忽略 */ }
    }
  });
} catch {
  console.warn('热更新不可用：当前环境不支持递归监视目录');
}

function serveHot(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  hotClients.add(res);
  req.on('close', () => hotClients.delete(res));
}

/* ---------- 静态文件 ---------- */

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/* ---------- 启动 ---------- */

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  try {
    if (pathname === '/api/hot') return serveHot(req, res);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: '不支持的请求方法' });
    }
    return serveStatic(res, pathname);
  } catch (err) {
    sendJson(res, 400, { error: err.message || '请求处理失败' });
  }
});

let port = BASE_PORT;
(function listen() {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + 10) {
      port += 1; // 端口被占就自动换下一个
      listen();
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log('功能台已启动:  http://' + HOST + ':' + port);
    console.log('数据文件:     ' + DATA_FILE);
    console.log('停止服务:     Ctrl + C');
  });
})();

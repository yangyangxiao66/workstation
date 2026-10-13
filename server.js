#!/usr/bin/env node
/* 功能台 —— HTTP 服务（静态页面 + REST API + 热更新），数据层在 lib/store.js */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');

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

/* ---------- API ---------- */

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/workspace') {
    return sendJson(res, 200, store.loadDb());
  }

  if (req.method === 'GET' && pathname === '/api/export.md') {
    const md = store.exportMarkdown(store.loadDb());
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(md);
  }

  /* ----- 项目 ----- */

  if (req.method === 'POST' && pathname === '/api/projects') {
    const body = await readBody(req);
    try {
      const db = store.loadDb();
      const p = store.createProject(db, body);
      store.saveDb(db);
      return sendJson(res, 201, p);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  let m = pathname.match(/^\/api\/projects\/(P-\d{3,})$/);
  if (m) {
    const pid = m[1];
    const db = store.loadDb();

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const p = store.updateProject(db, pid, body);
        if (!p) return sendJson(res, 404, { error: '项目不存在' });
        store.saveDb(db);
        return sendJson(res, 200, p);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === 'DELETE') {
      const ok = store.deleteProject(db, pid);
      if (!ok) return sendJson(res, 404, { error: '项目不存在' });
      store.saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  /* ----- 项目下的功能 ----- */

  m = pathname.match(/^\/api\/projects\/(P-\d{3,})\/features$/);
  if (m && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const db = store.loadDb();
      if (!db.projects.some((x) => x.id === m[1])) {
        return sendJson(res, 404, { error: '项目不存在' });
      }
      const f = store.createFeature(db, m[1], body);
      store.saveDb(db);
      return sendJson(res, 201, f);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  /* ----- 功能（跨项目按编号定位） ----- */

  m = pathname.match(/^\/api\/features\/(F-\d{4,})$/);
  if (m) {
    const id = m[1];
    const db = store.loadDb();

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const f = store.patchFeature(db, id, body);
        store.saveDb(db);
        return sendJson(res, 200, f);
      } catch (err) {
        return sendJson(res, err.message === '功能不存在' ? 404 : 400, { error: err.message });
      }
    }

    if (req.method === 'DELETE') {
      const ok = store.deleteFeature(db, id);
      if (!ok) return sendJson(res, 404, { error: '功能不存在' });
      store.saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  return sendJson(res, 404, { error: '接口不存在' });
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
    console.log('数据文件:     ' + store.DATA_FILE);
    console.log('停止服务:     Ctrl + C');
  });
})();

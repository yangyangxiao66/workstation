'use strict';

/* ---------- 常量与状态 ---------- */

const STATUS = {
  idea:    { label: '想法',   next: 'todo',  advance: '立项' },
  todo:    { label: '待开发', next: 'doing', advance: '开始' },
  doing:   { label: '开发中', next: 'done',  advance: '完成' },
  done:    { label: '已完成', next: 'todo',  advance: '重开' },
  shelved: { label: '已搁置', next: 'todo',  advance: '恢复' },
};
const ORDER = ['idea', 'todo', 'doing', 'done', 'shelved'];
const MD_ORDER = ['doing', 'todo', 'idea', 'shelved', 'done'];
const PRIORITY = { high: { label: '高', rank: 0 }, mid: { label: '中', rank: 1 }, low: { label: '低', rank: 2 } };

const state = {
  db: { projects: [], active: null, seq: 0, pseq: 0 },
  projectId: null,
  filter: { status: 'all', module: 'all', q: '' },
  sort: 'updated',
};

const $ = (id) => document.getElementById(id);
const els = {};

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  const day = Math.floor(h / 24);
  if (day === 1) return '昨天';
  if (day < 30) return day + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN');
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

/* ---------- 项目与功能 ---------- */

function activeProject() {
  return state.db.projects.find((p) => p.id === state.projectId) || null;
}

function feats() {
  const p = activeProject();
  return p ? p.features : [];
}

// 完成度：已完成 / (全部 - 已搁置)；全部搁置或无功能时返回 null
function completion(list) {
  const total = list.length;
  const shelved = list.filter((f) => f.status === 'shelved').length;
  const done = list.filter((f) => f.status === 'done').length;
  const planned = total - shelved;
  return {
    total,
    done,
    shelved,
    planned,
    pct: planned > 0 ? Math.round((done / planned) * 100) : null,
  };
}

function pctText(list) {
  const c = completion(list);
  if (!c.total) return '0%';
  if (c.pct === null) return '—';
  return c.pct + '%';
}

// 单个功能的完成度：优先用记录值；旧数据没有该字段时按状态推（完成=100，其余=0）
function fProgress(f) {
  if (typeof f.progress === 'number' && Number.isFinite(f.progress)) {
    return Math.max(0, Math.min(100, Math.round(f.progress)));
  }
  return f.status === 'done' ? 100 : 0;
}

/* ---------- 筛选与排序 ---------- */

function filterActive() {
  const { status, module, q } = state.filter;
  return status !== 'all' || module !== 'all' || q.trim() !== '';
}

function visibleRows() {
  const { status, module, q } = state.filter;
  const key = q.trim().toLowerCase();
  const rows = feats().filter((f) =>
    (status === 'all' || f.status === status) &&
    (module === 'all' || (f.module || '未分类') === module) &&
    (!key || (f.id + ' ' + f.title + ' ' + (f.desc || '') + ' ' + (f.tags || []).join(' ')).toLowerCase().includes(key))
  );
  const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
  if (state.sort === 'priority') {
    rows.sort((a, b) => (PRIORITY[a.priority] || PRIORITY.mid).rank - (PRIORITY[b.priority] || PRIORITY.mid).rank || byUpdated(a, b));
  } else if (state.sort === 'created') {
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else {
    rows.sort(byUpdated);
  }
  return rows;
}

/* ---------- 渲染 ---------- */

function render() {
  renderSidebar();
  renderHead();
  renderPipeline();
  renderList();
  updateModuleDatalist();
}

function statusCounts() {
  const c = { all: feats().length };
  for (const k of ORDER) c[k] = 0;
  for (const f of feats()) c[f.status] = (c[f.status] || 0) + 1;
  return c;
}

function sideItem(filterKey, value, label, count, color, active) {
  return '<button type="button" class="side-item' + (active ? ' active' : '') + '" data-' + filterKey + '="' + esc(value) + '" style="--sc:' + color + '">' +
    '<i class="dot" aria-hidden="true"></i>' +
    '<span class="side-label">' + esc(label) + '</span>' +
    '<span class="side-n">' + count + '</span>' +
  '</button>';
}

function renderSidebar() {
  // 项目列表（含各自完成度 + 「⋯」操作入口）
  els.sideProjects.innerHTML = '<div class="side-cap">项目</div>' +
    state.db.projects.map((p) =>
      '<div class="side-row">' +
        sideItem('proj', p.id, p.name, pctText(p.features), 'var(--accent)', p.id === state.projectId) +
        '<button type="button" class="proj-more" data-proj-menu="' + esc(p.id) + '" title="项目操作" aria-label="项目操作">⋯</button>' +
      '</div>'
    ).join('');

  const c = statusCounts();
  const rows = [['all', '全部', 'var(--ink)']]
    .concat(ORDER.map((k) => [k, STATUS[k].label, 'var(--c-' + k + ')']));
  els.sideStatus.innerHTML = '<div class="side-cap">功能状态</div>' +
    rows.map(([k, label, color]) => sideItem('status', k, label, c[k], color, state.filter.status === k)).join('');

  const counts = new Map();
  for (const f of feats()) {
    const m = f.module || '未分类';
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  const mods = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  els.sideModules.innerHTML = '<div class="side-cap">模块</div>' +
    sideItem('module', 'all', '全部模块', feats().length, 'var(--accent)', state.filter.module === 'all') +
    mods.map(([m, n]) => sideItem('module', m, m, n, 'var(--accent)', state.filter.module === m)).join('');
}

function renderHead() {
  const p = activeProject();
  if (!p) {
    els.topbar.style.display = 'none';
    els.pipeline.style.display = 'none';
    els.phead.innerHTML =
      '<div class="phead-name"><h2>功能台</h2></div>' +
      '<div class="phead-acts"><button type="button" class="btn primary" data-act="new-project">＋ 新建项目</button></div>';
    return;
  }
  els.topbar.style.display = '';
  els.pipeline.style.display = '';

  const c = completion(p.features);
  // 堆叠进度条：已完成在最左（进度条惯例），其余按推进方向排布
  const BAR_ORDER = ['done', 'doing', 'todo', 'idea', 'shelved'];
  const segs = BAR_ORDER
    .map((k) => ({ k, n: p.features.filter((f) => f.status === k).length }))
    .filter((s) => s.n > 0);
  const barHtml = segs.map((s) =>
    '<i style="width:' + (s.n / c.total * 100) + '%;background:var(--c-' + s.k + ')" title="' + STATUS[s.k].label + ' ' + s.n + '"></i>'
  ).join('');

  const pctLabel = c.pct === null ? '—' : c.pct + '%';
  const progText = c.total
    ? '<b>' + c.done + '/' + c.planned + '</b> 完成 · ' + pctLabel + (c.shelved ? '（另有搁置 ' + c.shelved + '）' : '')
    : '还没有功能';

  els.phead.innerHTML =
    '<div class="phead-left">' +
      '<div class="phead-name"><h2>' + esc(p.name) + '</h2></div>' +
      (p.desc ? '<p class="phead-desc">' + esc(p.desc) + '</p>' : '') +
      '<div class="phead-prog">' +
        '<div class="progress" role="img" aria-label="完成度 ' + pctLabel + '">' + barHtml + '</div>' +
        '<span class="prog-text">' + progText + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="phead-acts">' +
      '<button type="button" class="btn primary" data-act="new-project">＋ 新建项目</button>' +
    '</div>';
}

function renderPipeline() {
  const c = statusCounts();
  const keys = ['all', ...ORDER];
  // 段宽与数量成正比；给每段一个最小宽度，防止零计数段的文字被裁切
  els.pipeline.style.gridTemplateColumns = keys.map((k) => 'minmax(68px, ' + (c[k] || 0.45) + 'fr)').join(' ');
  els.pipeline.innerHTML = keys
    .map((k) => {
      const label = k === 'all' ? '全部' : STATUS[k].label;
      const color = k === 'all' ? 'var(--ink)' : 'var(--c-' + k + ')';
      const active = state.filter.status === k ? ' active' : '';
      return '<button type="button" class="seg' + active + '" data-status="' + k + '" style="--sc:' + color + '">' +
        '<span class="seg-n">' + c[k] + '</span><span class="seg-l">' + label + '</span></button>';
    })
    .join('');
}

function updateModuleDatalist() {
  const mods = [...new Set(feats().map((f) => f.module || '未分类'))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  $('moduleList').innerHTML = mods.map((m) => '<option value="' + esc(m) + '">').join('');
}

function renderList() {
  const p = activeProject();

  // 没有任何项目
  if (!state.db.projects.length) {
    els.list.innerHTML = emptyHtml('还没有项目', '先创建一个项目，再往里面录入功能。', '创建第一个项目', 'new-project');
    return;
  }
  // 项目里还没有功能
  if (p && !p.features.length) {
    els.list.innerHTML = emptyHtml('这个项目还没有功能', '把想到的功能记下来，开发时就不怕忘。', '录入第一个功能', 'new');
    return;
  }

  const rows = visibleRows();
  els.count.textContent = filterActive()
    ? '共 ' + feats().length + ' 项 · 显示 ' + rows.length + ' 项'
    : '共 ' + feats().length + ' 项';

  if (!rows.length) {
    els.list.innerHTML = emptyHtml('没有匹配的功能', '换个关键词，或清除当前筛选。', '清除筛选', 'clear');
    return;
  }
  // 分层区域：按状态分组展示（先做正在进行的，已完成的沉底）
  const GROUP_ORDER = MD_ORDER; // doing → todo → idea → shelved → done
  const filtered = filterActive();
  let html =
    '<table class="ftable"><thead><tr>' +
      '<th>编号</th><th>功能</th><th>状态</th><th>完成度</th><th>优先级</th><th>模块</th><th>标签</th><th>更新</th><th>操作</th>' +
    '</tr></thead><tbody>';
  for (const st of GROUP_ORDER) {
    const group = rows.filter((f) => f.status === st);
    if (!group.length && filtered) continue; // 筛选时省略空区块，平时保留区块骨架
    html += groupHeaderRow(st, group.length);
    html += group.map(rowHtml).join('');
  }
  html += '</tbody></table>';
  els.list.innerHTML = html;
}

function groupHeaderRow(st, n) {
  return '<tr class="grp" style="--sc:var(--c-' + st + ')"><td colspan="9">' +
    '<span class="grp-label">' + STATUS[st].label + '</span><span class="grp-n">' + n + '</span>' +
  '</td></tr>';
}

function rowHtml(f) {
  const st = STATUS[f.status];
  const prio = PRIORITY[f.priority] || PRIORITY.mid;
  const pr = fProgress(f);
  const canShelve = ['idea', 'todo', 'doing'].includes(f.status);
  return '<tr style="--sc:var(--c-' + f.status + ')">' +
    '<td class="c-id">' + esc(f.id) + '</td>' +
    '<td class="c-title"><span class="t">' + esc(f.title) + '</span>' +
      (f.desc ? '<span class="d">' + esc(f.desc) + '</span>' : '') + '</td>' +
    '<td><span class="chip">' + st.label + '</span></td>' +
    '<td class="c-prog"><span class="mini-bar"><i style="width:' + pr + '%"></i></span><span class="mini-num">' + pr + '%</span></td>' +
    '<td><span class="prio ' + esc(f.priority) + '">' + prio.label + '</span></td>' +
    '<td class="c-mod">' + esc(f.module || '未分类') + '</td>' +
    '<td class="c-tags">' + (f.tags || []).map((t) => '#' + esc(t)).join(' ') + '</td>' +
    '<td class="c-time">' + relTime(f.updatedAt) + '</td>' +
    '<td class="c-ops"><span class="acts">' +
      '<button type="button" class="act" data-act="advance" data-id="' + f.id + '">' + st.advance + '</button>' +
      (canShelve ? '<button type="button" class="act" data-act="shelve" data-id="' + f.id + '">搁置</button>' : '') +
      '<button type="button" class="act" data-act="edit" data-id="' + f.id + '">编辑</button>' +
      '<button type="button" class="act del" data-act="del" data-id="' + f.id + '">删除</button>' +
    '</span></td>' +
  '</tr>';
}

function emptyHtml(title, desc, btn, act) {
  return '<div class="empty"><div class="empty-title">' + title + '</div><p>' + desc + '</p>' +
    '<button type="button" class="btn primary" data-act="' + act + '">' + btn + '</button></div>';
}

/* ---------- 数据操作 ---------- */

async function refresh(keepProject) {
  const data = await api('GET', '/api/workspace');
  state.db = data;
  if (keepProject && data.projects.some((p) => p.id === keepProject)) {
    state.projectId = keepProject;
  } else {
    state.projectId = data.active && data.projects.some((p) => p.id === data.active)
      ? data.active
      : (data.projects[0] ? data.projects[0].id : null);
  }
  render();
}

async function patchFeature(id, body, msg) {
  try {
    await api('PATCH', '/api/features/' + id, body);
    await refresh(state.projectId);
    if (msg) toast(msg);
  } catch (err) {
    toast(err.message);
  }
}

async function switchProject(id) {
  state.projectId = id;
  state.filter = { status: 'all', module: 'all', q: '' };
  els.search.value = '';
  render();
  try {
    await api('PATCH', '/api/projects/' + id, { active: true });
  } catch { /* 记不住也没关系 */ }
}

/* ---------- 居中确认弹窗 ---------- */

// confirmAction({title, msg, okText}) → Promise<boolean>，点删除/确定返回 true
function confirmAction(opt) {
  return new Promise((resolve) => {
    els.cTitle.textContent = (opt && opt.title) || '确认操作';
    els.cMsg.textContent = (opt && opt.msg) || '';
    els.cOk.textContent = (opt && opt.okText) || '删除';
    els.cmodal.showModal();

    function cleanup() {
      els.cOk.removeEventListener('click', onOk);
      els.cCancel.removeEventListener('click', onCancel);
      els.cmodal.removeEventListener('close', onClose);
    }
    function finish(v) {
      cleanup();
      resolve(v);
    }
    function onOk() {
      els.cmodal.close();
      finish(true);
    }
    function onCancel() {
      els.cmodal.close();
      finish(false);
    }
    // Esc / 点遮罩关闭 = 取消
    function onClose() {
      cleanup();
      resolve(false);
    }

    els.cOk.addEventListener('click', onOk);
    els.cCancel.addEventListener('click', onCancel);
    els.cmodal.addEventListener('close', onClose);
  });
}

async function onDeleteFeature(f) {
  const ok = await confirmAction({
    title: '删除功能',
    msg: '删除 ' + f.id + '「' + f.title + '」？此操作不可恢复。',
  });
  if (!ok) return;
  try {
    await api('DELETE', '/api/features/' + f.id);
    await refresh(state.projectId);
    toast('已删除 ' + f.id);
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- 项目「⋯」操作菜单 ---------- */

function closeProjMenu() {
  const m = document.getElementById('projMenu');
  if (m) m.remove();
}

function openProjMenu(btn, pid) {
  closeProjMenu();
  const menu = document.createElement('div');
  menu.className = 'proj-menu';
  menu.id = 'projMenu';
  menu.innerHTML =
    '<button type="button" class="pm-item" data-pact="rename">重命名</button>' +
    '<button type="button" class="pm-item pm-danger" data-pact="del">删除项目</button>';
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';

  menu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = e.target.closest('.pm-item');
    if (!item) return;
    if (item.dataset.pact === 'rename') {
      closeProjMenu();
      const p = state.db.projects.find((x) => x.id === pid);
      if (p) openProjectModal(p);
    } else if (item.dataset.pact === 'del') {
      closeProjMenu();
      const p = state.db.projects.find((x) => x.id === pid);
      if (!p) return;
      const n = p.features.length;
      const ok = await confirmAction({
        title: '删除项目',
        msg: '删除项目「' + p.name + '」？' + (n ? '项目下的 ' + n + ' 个功能会一起删除，' : '') + '此操作不可恢复。',
        okText: '删除项目',
      });
      if (!ok) return;
      try {
        await api('DELETE', '/api/projects/' + pid);
        await refresh(pid === state.projectId ? null : state.projectId);
        toast('已删除项目：' + p.name);
      } catch (err) {
        toast(err.message);
      }
    }
  });
}

/* ---------- 复制 Markdown ---------- */

function buildMarkdown(rows) {
  const p = activeProject();
  const all = feats();
  const lines = [
    '# ' + (p ? p.name : '功能清单'),
    '',
    '> 更新于 ' + new Date().toLocaleString('zh-CN') +
      (rows.length !== all.length ? ' ｜ 当前筛选 ' + rows.length + '/' + all.length + ' 项' : ' ｜ 共 ' + all.length + ' 项'),
    '',
  ];
  for (const st of MD_ORDER) {
    const group = rows.filter((f) => f.status === st);
    if (!group.length) continue;
    lines.push('## ' + STATUS[st].label + '（' + group.length + '）', '');
    for (const f of group) {
      const tags = f.tags && f.tags.length ? ' ｜ ' + f.tags.map((t) => '#' + t).join(' ') : '';
      const prio = (PRIORITY[f.priority] || PRIORITY.mid).label;
      lines.push('- **' + f.id + ' ' + f.title + '** ｜ 模块:' + (f.module || '未分类') + ' ｜ 优先级:' + prio + ' ｜ 完成:' + fProgress(f) + '%' + tags);
      if (f.desc) lines.push('  ' + f.desc.replace(/\r?\n/g, ' '));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------- 自绘下拉框（圆角弹层，替代原生 select 的系统样式） ---------- */

function initDd(select) {
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add('dd-native');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  const pop = document.createElement('div');
  pop.className = 'dd-pop';
  pop.setAttribute('role', 'listbox');
  wrap.appendChild(btn);
  wrap.appendChild(pop);

  function render() {
    const cur = select.selectedOptions[0] || select.options[0];
    btn.innerHTML = '<span class="dd-label">' + esc(cur ? cur.textContent : '') + '</span><i class="dd-caret" aria-hidden="true"></i>';
    pop.innerHTML = [...select.options].map((o) =>
      '<button type="button" class="dd-opt' + (o.value === select.value ? ' sel' : '') + '" role="option" data-v="' + esc(o.value) + '">' + esc(o.textContent) + '</button>'
    ).join('');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.dd.open').forEach((d) => { if (d !== wrap) d.classList.remove('open'); });
    wrap.classList.toggle('open');
    if (wrap.classList.contains('open')) {
      const sel = pop.querySelector('.dd-opt.sel');
      (sel || pop.querySelector('.dd-opt')).focus();
    }
  });

  pop.addEventListener('click', (e) => {
    const o = e.target.closest('.dd-opt');
    if (!o) return;
    e.stopPropagation();
    select.value = o.dataset.v;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    render();
    wrap.classList.remove('open');
    btn.focus();
  });

  pop.addEventListener('keydown', (e) => {
    const opts = [...pop.querySelectorAll('.dd-opt')];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.remove('open');
      btn.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      opts[Math.min(i + 1, opts.length - 1)].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      opts[Math.max(i - 1, 0)].focus();
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      opts[i].click();
    }
  });

  document.addEventListener('click', () => wrap.classList.remove('open'));
  select._ddRender = render;
  render();
}

// 程序化改了 select.value 之后调用，刷新按钮显示
function syncDd(select) {
  if (select._ddRender) select._ddRender();
}

/* ---------- 弹窗 ---------- */

let editingFeatureId = null;
let editingProjectId = null;

function setProgressUI(v) {
  els.fProgress.value = v;
  els.fProgressVal.textContent = v + '%';
}

function openFeatureModal(f) {
  editingFeatureId = f ? f.id : null;
  els.modalTitle.textContent = f ? '编辑 ' + f.id : '新功能';
  els.fTitle.value = f ? f.title : '';
  els.fDesc.value = f ? f.desc || '' : '';
  els.fModule.value = f ? f.module || '' : '';
  els.fStatus.value = f ? f.status : 'todo';
  els.fPriority.value = f ? f.priority : 'mid';
  setProgressUI(f ? fProgress(f) : 0);
  els.fTags.value = f && f.tags ? f.tags.join(', ') : '';
  syncDd(els.fStatus);
  syncDd(els.fPriority);
  els.modal.showModal();
  els.fTitle.focus();
}

function openProjectModal(p) {
  editingProjectId = p ? p.id : null;
  els.pmodalTitle.textContent = p ? '重命名 ' + p.id : '新建项目';
  els.pName.value = p ? p.name : '';
  els.pDesc.value = p ? p.desc || '' : '';
  els.pmodal.showModal();
  els.pName.focus();
}

/* ---------- 事件绑定 ---------- */

function bind() {
  els.btnCancel.addEventListener('click', () => els.modal.close());
  els.pCancel.addEventListener('click', () => els.pmodal.close());

  // 小屏：打开 / 关闭侧栏抽屉
  els.btnMenu.addEventListener('click', () => els.side.classList.toggle('open'));

  // 新建/编辑弹窗只能通过 × 或「取消」关闭：点遮罩、按 Esc 都不关，防止误触丢失已填内容
  els.modalX.addEventListener('click', () => els.modal.close());
  els.pmodalX.addEventListener('click', () => els.pmodal.close());
  els.modal.addEventListener('cancel', (e) => e.preventDefault());
  els.pmodal.addEventListener('cancel', (e) => e.preventDefault());

  // 确认弹窗保持轻量：点遮罩 = 取消
  els.cmodal.addEventListener('click', (e) => { if (e.target === els.cmodal) els.cmodal.close(); });

  // 功能表单
  els.fProgress.addEventListener('input', () => {
    els.fProgressVal.textContent = els.fProgress.value + '%';
  });

  // 选成「已完成」时完成度自动拉满；改回其他状态交还手动控制
  els.fStatus.addEventListener('change', () => {
    if (els.fStatus.value === 'done') setProgressUI(100);
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: els.fTitle.value,
      desc: els.fDesc.value,
      module: els.fModule.value,
      status: els.fStatus.value,
      priority: els.fPriority.value,
      progress: Number(els.fProgress.value),
      tags: els.fTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
    };
    try {
      if (editingFeatureId) {
        await api('PATCH', '/api/features/' + editingFeatureId, body);
        toast('已保存修改');
      } else {
        await api('POST', '/api/projects/' + state.projectId + '/features', body);
        toast('已录入新功能');
      }
      els.modal.close();
      await refresh(state.projectId);
    } catch (err) {
      toast(err.message);
    }
  });

  // 项目表单
  els.pform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: els.pName.value, desc: els.pDesc.value };
    try {
      if (editingProjectId) {
        await api('PATCH', '/api/projects/' + editingProjectId, body);
        toast('已保存项目');
      } else {
        await api('POST', '/api/projects', body);
        toast('已创建项目：' + body.name);
      }
      els.pmodal.close();
      // 新建项目后服务端已把 active 指向它；重命名则保持当前项目
      await refresh(editingProjectId);
    } catch (err) {
      toast(err.message);
    }
  });

  // 侧栏导航 + 项目「⋯」菜单入口
  els.side.addEventListener('click', (e) => {
    const more = e.target.closest('.proj-more');
    if (more) {
      e.stopPropagation();
      openProjMenu(more, more.dataset.projMenu);
      return;
    }
    const item = e.target.closest('.side-item');
    if (!item) return;
    if (item.dataset.proj) {
      if (item.dataset.proj !== state.projectId) switchProject(item.dataset.proj);
    } else if (item.dataset.status) {
      state.filter.status = state.filter.status === item.dataset.status ? 'all' : item.dataset.status;
      render();
    } else if (item.dataset.module) {
      state.filter.module = state.filter.module === item.dataset.module ? 'all' : item.dataset.module;
      render();
    }
    els.side.classList.remove('open');
  });

  // 概览条点击同样可以筛选
  els.pipeline.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    state.filter.status = state.filter.status === seg.dataset.status ? 'all' : seg.dataset.status;
    render();
  });

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filter.q = els.search.value;
      renderList();
    }, 150);
  });

  els.sortSel.addEventListener('change', () => {
    state.sort = els.sortSel.value;
    renderList();
  });

  els.btnNew.addEventListener('click', () => {
    if (!activeProject()) return toast('请先创建一个项目');
    openFeatureModal();
  });

  els.btnCopy.addEventListener('click', async () => {
    if (!activeProject()) return toast('请先创建一个项目');
    const md = buildMarkdown(visibleRows());
    const ok = await copyText(md);
    toast(ok ? '已复制 Markdown，可直接粘给 AI' : '复制失败，可访问 /api/export.md 获取');
  });

  // 项目头部操作 + 功能表格操作（事件委托）
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if (act === 'new-project') return openProjectModal();
    if (act === 'new') return openFeatureModal();
    if (act === 'clear') {
      state.filter = { status: 'all', module: 'all', q: '' };
      els.search.value = '';
      return render();
    }

    const f = feats().find((x) => x.id === id);
    if (!f) return;
    if (act === 'advance') {
      patchFeature(f.id, { status: STATUS[f.status].next }, '已' + STATUS[f.status].advance + '：' + f.title);
    } else if (act === 'shelve') {
      patchFeature(f.id, { status: 'shelved' }, '已搁置：' + f.title);
    } else if (act === 'edit') {
      openFeatureModal(f);
    } else if (act === 'del') {
      onDeleteFeature(f);
    }
  });

  // 按 / 快速聚焦搜索框；Esc 关闭项目菜单
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      els.search.focus();
    }
    if (e.key === 'Escape') closeProjMenu();
  });

  // 点击菜单外部关闭项目菜单
  document.addEventListener('click', closeProjMenu);
}

/* ---------- 启动 ---------- */

function init() {
  for (const id of ['side', 'btnMenu', 'sideProjects', 'sideStatus', 'sideModules', 'pipeline',
    'search', 'sortSel', 'count', 'btnCopy', 'btnNew', 'list', 'topbar', 'phead',
    'modal', 'modalTitle', 'form', 'btnCancel', 'fTitle', 'fDesc', 'fModule', 'fStatus',
    'fPriority', 'fProgress', 'fProgressVal', 'fTags', 'pmodal', 'pmodalTitle', 'pform',
    'pCancel', 'pName', 'pDesc', 'modalX', 'pmodalX', 'cmodal', 'cTitle', 'cMsg',
    'cOk', 'cCancel', 'toast']) {
    els[id] = $(id);
  }
  bind();
  // 三个下拉框换成自绘圆角样式
  [els.sortSel, els.fStatus, els.fPriority].forEach(initDd);
  refresh().catch((e) => toast('加载失败：' + e.message));
}

init();

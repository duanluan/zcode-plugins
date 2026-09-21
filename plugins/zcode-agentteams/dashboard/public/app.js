/* AgentTeams 活动面板前端：轮询 /api/state 渲染项目/队长/进度/成员/任务依赖 DAG。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATUS_LABEL = {
    pending: '待领取',
    delegated: '已派发',
    'in-progress': '工作中',
    completed: '已交付',
    revision: '待复核',
    blocked: '已阻塞',
  };
  const PROGRESS_LABEL = {
    running: '运行中',
    delegated: '已派发',
    pending: '等待派发',
    completed: '已交付',
    revision: '待复核',
    blocked: '已阻塞',
  };
  const MEMBER_STATUS = {
    working: ['工作中', 'st-text-working'],
    waiting: ['等待', 'st-text-waiting'],
    delegated: ['已派发', 'st-text-delegated'],
    done: ['已交付', 'st-text-done'],
    blocked: ['已阻塞', 'st-text-blocked'],
  };
  const AVATAR_COLORS = ['#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#f97316', '#14b8a6', '#a855f7'];

  let state = null;
  let selectedProject = null; // 用户在下拉里选过的项目 id
  let pinnedTask = null; // DAG 上被点击固定的任务
  let hoveredTask = null;
  let paused = false;
  let timer = null;
  let lastDataHash = null; // 数据未变化时跳过重渲染，避免打断悬停/点击交互

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const avatarColor = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  };
  const trunc = (s, n) => {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };

  async function fetchState() {
    const q = selectedProject ? `?project=${encodeURIComponent(selectedProject)}` : '';
    const res = await fetch(`/api/state${q}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- 渲染 ----------

  function render() {
    if (!state) return;
    renderError();
    renderTopbar();
    const root = $('content');
    if (!state.project) {
      root.innerHTML = `<div class="card"><div class="loading">${esc(state.hint ?? state.error?.message ?? '暂无项目数据')}</div></div>`;
      return;
    }
    root.innerHTML = [
      renderProjectCard(),
      renderCaptainCard(),
      renderProgress(),
      renderMembers(),
      renderMessages(),
      renderDag(),
    ].join('');
    bindDag();
    renderDetail();
  }

  function renderError() {
    const banner = $('error-banner');
    if (state.error) {
      banner.innerHTML = `<b>${esc(state.error.message)}</b>${state.error.detail ? ' — ' + esc(state.error.detail) : ''}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    const dot = $('status-dot');
    dot.className = 'dot ' + (state.error ? 'error' : state.project?.status === 'active' ? 'active' : 'paused');
    $('demo-badge').classList.toggle('hidden', !state.config?.demo);
  }

  function renderTopbar() {
    const sel = $('project-select');
    const projects = state.projects ?? [];
    if (projects.length) {
      sel.classList.remove('hidden');
      const current = state.project?.id;
      sel.innerHTML = projects
        .map((p) => `<option value="${esc(p.id)}" ${p.id === current ? 'selected' : ''}>${esc(trunc(p.title, 28))}</option>`)
        .join('');
    } else {
      sel.innerHTML = '<option>—</option>';
    }
    $('updated').textContent = state.generatedAt
      ? `更新于 ${new Date(state.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '';
  }

  function renderProjectCard() {
    const p = state.project;
    const modeNote = state.config?.mode === 'hiclaw' ? ' · 本地控制面' : state.config?.mode === 'agt' ? ' · agt CLI' : '';
    const meta =
      p.taskTotal > 0
        ? `<span><b>${p.memberCount}</b> 名成员</span>
           <span><b>${p.taskCompleted}/${p.taskTotal}</b> 完成</span>
           <span><b>${p.messageCount}</b> 条消息</span>`
        : `<span><b>${p.memberCount}</b> 名成员</span>
           <span><b>${state.captain?.executing ?? 0}</b> 人执行中</span>`;
    return `<section class="card project-card">
      <div class="project-title-row">
        <h2>${esc(p.title)}${modeNote}</h2>
        <div class="project-meta">${meta}</div>
      </div>
    </section>`;
  }

  function renderCaptainCard() {
    const c = state.captain;
    if (!c) return '';
    const sub =
      c.dispatched != null
        ? `已派发 ${c.dispatched} 项任务给 ${c.memberCount} 名成员`
        : `管理 ${c.memberCount} 名成员${c.executing ? `，${c.executing} 人执行中` : ''}`;
    return `<section class="card captain-card">
      <div class="avatar avatar-captain">🐳</div>
      <div class="captain-info">
        <div class="captain-name"><span class="role">队长</span> ${esc(c.name)}
          ${c.faction ? `<span class="badge badge-faction">派系: ${esc(c.faction)}</span>` : ''}
          ${c.model ? `<span class="badge badge-model">${esc(c.model)}</span>` : ''}
          ${!c.model && state.project?.teamId ? `<span class="badge badge-model">${esc(state.project.teamId)}</span>` : ''}
        </div>
        <div class="captain-sub">${esc(sub)}</div>
      </div>
      ${c.dispatched != null ? `<div class="captain-right"><span class="exec-icon">⣿</span>${c.executing} 人执行中</div>` : ''}
    </section>`;
  }

  function renderProgress() {
    const p = state.progress;
    if (!p.total) {
      return `<section class="card">
        <div class="progress-label">总进度</div>
        <div class="pending-hint">ℹ️ ${esc(state.hint ?? '该数据源未提供任务列表，仅展示团队与成员状态')}</div>
      </section>`;
    }
    const total = p.total;
    const segs = Object.entries(PROGRESS_LABEL)
      .map(([k, label]) => ({ k, label, v: p[k] ?? 0 }))
      .filter((s) => s.v > 0);
    const bar = segs
      .map((s) => `<div class="seg seg-${s.k}" style="width:${(s.v / total) * 100}%" title="${s.label} ${s.v}"></div>`)
      .join('');
    const legend = segs
      .map((s) => `<span class="legend-chip"><i class="seg-${s.k}"></i><b>${s.v}</b> ${s.label}</span>`)
      .join('');
    return `<section class="card">
      <div class="progress-label">总进度</div>
      <div class="progress-bar">${p.total ? bar : ''}</div>
      <div class="progress-legend">${legend}</div>
      ${state.pendingHint ? `<div class="pending-hint">📌 ${esc(state.pendingHint)}</div>` : ''}
    </section>`;
  }

  function renderMembers() {
    const members = state.members ?? [];
    if (!members.length) return '';
    const cards = members
      .map((m) => {
        const [label, cls] = MEMBER_STATUS[m.status] ?? [m.status, ''];
        const chips = m.tasks
          .map(
            (t) =>
              `<button class="chip st-${t.status}" data-task="${esc(t.id)}" title="${esc(t.name)} · ${STATUS_LABEL[t.status]}">${esc(t.id)}</button>`
          )
          .join('');
        return `<div class="member-card status-${esc(m.status)}">
        <div class="avatar" style="--av:${avatarColor(m.name)}">${esc((m.display || m.name)[0].toUpperCase())}</div>
        <div class="member-main">
          <div class="member-name-row"><b>${esc(m.display || m.name)}</b>${m.model ? `<span class="badge badge-model">${esc(m.model)}</span>` : ''}</div>
          ${m.desc ? `<div class="member-desc">${esc(m.desc)}</div>` : ''}
          ${m.runningTask ? `<div class="member-running">正在执行 <b>${esc(m.runningTask.id)}</b>${m.runningTask.detail ? ' · ' + esc(m.runningTask.detail) : ''}</div>` : ''}
          ${m.tasks.length ? `<div class="member-chips"><span>队长派发:</span>${chips}</div>` : ''}
        </div>
        <div class="member-side">
          <div class="member-status ${cls}">${m.status === 'working' ? '<span class="spin">⚙</span> ' : ''}${label}</div>
          ${m.total ? `<div class="member-progress">${m.done}/${m.total}</div>` : ''}
        </div>
      </div>`;
      })
      .join('');
    return `<section id="members-section">
      <div class="section-head"><span class="chev">▼</span> ${members.length} 名成员
        <span class="toggle" id="members-toggle">收起</span>
      </div>
      <div id="member-list">${cards}</div>
    </section>`;
  }

  function renderMessages() {
    const msgs = state.messages ?? [];
    if (!msgs.length) return '';
    const items = msgs
      .map((m) => {
        const time = m.createdAt
          ? new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
          : '';
        return `<div class="msg-item">
        <div class="avatar" style="--av:${avatarColor(m.worker)}">${esc((m.worker || '?')[0].toUpperCase())}</div>
        <div class="msg-main">
          <div class="msg-head">
            <b>${esc(m.worker)}</b>
            ${m.room ? `<span class="msg-room">${esc(trunc(m.room, 24))}</span>` : ''}
            ${time ? `<span class="msg-time">${time}</span>` : ''}
          </div>
          <div class="msg-body">${esc(trunc(m.content, 200))}</div>
        </div>
      </div>`;
      })
      .join('');
    return `<section class="card messages-card">
      <div class="section-head">💬 最近消息</div>
      ${items}
    </section>`;
  }

  // ---------- DAG ----------

  function dagGeometry(nodes, edges) {
    const preds = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e) => {
      if (preds.has(e.target)) preds.get(e.target).push(e.source);
    });
    const layer = new Map();
    const inStack = new Set();
    const depth = (id) => {
      if (layer.has(id)) return layer.get(id);
      if (inStack.has(id)) return 0; // 依赖环兜底
      inStack.add(id);
      const ps = preds.get(id) ?? [];
      const v = ps.length ? Math.max(...ps.map(depth)) + 1 : 0;
      inStack.delete(id);
      layer.set(id, v);
      return v;
    };
    nodes.forEach((n) => depth(n.id));

    const NW = 152, NH = 46, GX = 52, GY = 20, M = 14;
    const cols = new Map();
    for (const n of nodes) {
      const c = layer.get(n.id);
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push(n);
    }
    const pos = new Map();
    let maxLayer = 0, maxRows = 1;
    for (const [c, list] of cols) {
      maxLayer = Math.max(maxLayer, c);
      maxRows = Math.max(maxRows, list.length);
      list.forEach((n, i) => pos.set(n.id, { x: M + c * (NW + GX), y: M + i * (NH + GY) }));
    }
    return {
      pos, NW, NH,
      width: M * 2 + maxLayer * (NW + GX) + NW,
      height: M * 2 + maxRows * (NH + GY) - GY,
      preds,
    };
  }

  function renderDag() {
    const { nodes, edges } = state.workflow;
    if (!nodes?.length) {
      const why = state.config?.mode === 'hiclaw' ? '（本地 Docker 控制面为团队/成员模型，未暴露 tasks API）' : '';
      return `<section class="dag-section">
        <div class="section-head">🗂 任务依赖 <span class="hint">悬停高亮依赖链 · 点击固定</span></div>
        <div class="card dag-card"><div class="loading">暂无任务依赖数据${why}</div></div>
      </section>`;
    }
    return `<section class="dag-section">
      <div class="section-head">🗂 任务依赖 <span class="hint">悬停高亮依赖链 · 点击固定</span></div>
      <div class="card dag-card"><div class="dag-scroll"><svg id="dag-svg" width="10" height="10"></svg></div></div>
    </section>`;
  }

  function bindDag() {
    const { nodes, edges } = state.workflow;
    if (!nodes?.length) return;
    const svg = $('dag-svg');
    const geo = dagGeometry(nodes, edges);
    const NS = 'http://www.w3.org/2000/svg';
    svg.setAttribute('width', geo.width);
    svg.setAttribute('height', geo.height);
    svg.setAttribute('viewBox', `0 0 ${geo.width} ${geo.height}`);
    svg.innerHTML = '';
    svg.__geo = geo;

    for (const e of edges) {
      const a = geo.pos.get(e.source), b = geo.pos.get(e.target);
      if (!a || !b) continue;
      const x1 = a.x + geo.NW, y1 = a.y + geo.NH / 2, x2 = b.x, y2 = b.y + geo.NH / 2;
      const mx = (x1 + x2) / 2;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      p.setAttribute('class', `dag-edge${e.conditional ? ' conditional' : ''}${e.source === pinnedTask || e.target === pinnedTask ? ' active' : ''}`);
      p.dataset.source = e.source;
      p.dataset.target = e.target;
      svg.appendChild(p);
    }

    for (const n of nodes) {
      const g = document.createElementNS(NS, 'g');
      const pt = geo.pos.get(n.id);
      g.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
      g.setAttribute('class', `dag-node${n.id === pinnedTask ? ' pinned' : ''}`);
      g.dataset.id = n.id;

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('width', geo.NW);
      rect.setAttribute('height', geo.NH);
      rect.setAttribute('rx', 10);
      g.appendChild(rect);

      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', 13);
      dot.setAttribute('cy', geo.NH / 2);
      dot.setAttribute('r', 4.5);
      dot.setAttribute('fill', { pending: '#f0b429', delegated: '#3b82f6', 'in-progress': '#d6336c', completed: '#22a55e', revision: '#ea580c', blocked: '#dc2626' }[n.status] ?? '#9ca3af');
      g.appendChild(dot);

      const t1 = document.createElementNS(NS, 'text');
      t1.setAttribute('x', 25);
      t1.setAttribute('y', 19);
      t1.setAttribute('class', 'n-id');
      t1.textContent = `${n.id} ${n.id === pinnedTask ? '📌' : ''}`;
      g.appendChild(t1);

      const t2 = document.createElementNS(NS, 'text');
      t2.setAttribute('x', 25);
      t2.setAttribute('y', 35);
      t2.setAttribute('class', 'n-name');
      t2.textContent = trunc(n.name, 16);
      g.appendChild(t2);

      g.addEventListener('mouseenter', () => { hoveredTask = n.id; applyHighlight(); });
      g.addEventListener('mouseleave', () => { hoveredTask = null; applyHighlight(); });
      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        pinnedTask = pinnedTask === n.id ? null : n.id;
        render();
      });
      svg.appendChild(g);
    }

    svg.addEventListener('click', () => { pinnedTask = null; render(); });

    // 成员卡 / 详情里的任务 chip 也联动选中
    document.querySelectorAll('[data-task]').forEach((el) => {
      el.addEventListener('click', () => {
        pinnedTask = el.dataset.task;
        render();
        $('detail').scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    });

    const toggle = $('members-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const sec = $('members-section');
        sec.classList.toggle('collapsed');
        const hidden = sec.classList.contains('collapsed');
        $('member-list').classList.toggle('hidden', hidden);
        toggle.textContent = hidden ? '展开' : '收起';
      });
    }
    applyHighlight();
  }

  function ancestorsOf(id) {
    const geo = $('dag-svg')?.__geo;
    if (!geo) return new Set();
    const out = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const p of geo.preds.get(cur) ?? []) {
        if (!out.has(p)) {
          out.add(p);
          stack.push(p);
        }
      }
    }
    return out;
  }

  function applyHighlight() {
    const svg = $('dag-svg');
    if (!svg) return;
    const focus = pinnedTask ?? hoveredTask;
    const chain = focus ? ancestorsOf(focus) : null;
    chain?.add(focus);
    svg.querySelectorAll('.dag-node').forEach((g) => {
      const id = g.dataset.id;
      g.classList.toggle('selected', id === focus);
      g.classList.toggle('pinned', id === pinnedTask);
      g.classList.toggle('dim', Boolean(focus) && !chain.has(id));
    });
    svg.querySelectorAll('.dag-edge').forEach((p) => {
      const inChain = Boolean(focus) && chain.has(p.dataset.source) && chain.has(p.dataset.target);
      p.classList.toggle('active', inChain);
      p.classList.toggle('dim', Boolean(focus) && !inChain);
    });
  }

  // ---------- 详情面板 ----------

  function renderDetail() {
    const panel = $('detail');
    const id = pinnedTask;
    if (!id || !state.tasks?.[id]) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }
    const t = state.tasks[id];
    const incompletePreds = t.blockedBy.filter((p) => state.tasks[p] && state.tasks[p].status !== 'completed');
    const member = (state.members ?? []).find((m) => m.name === t.assignee);
    const waitText = incompletePreds.length
      ? `等待 ${incompletePreds.join('、')}`
      : t.status === 'in-progress'
        ? '正在执行'
        : t.status === 'completed'
          ? '已完成'
          : '可开工';
    const unlocksText = t.unlocks.length ? `完成后解锁 ${t.unlocks.join('、')}` : '无下游任务';
    const artifact =
      state.config?.mode === 'controller' && t.resultPath
        ? `<a href="/api/artifact?project=${encodeURIComponent(state.project.id)}&task=${encodeURIComponent(t.id)}">下载工件</a>`
        : '';
    panel.innerHTML = `<div class="detail-inner">
      <div class="detail-head">
        <span class="chip st-${esc(t.status)}" style="cursor:default">${esc(t.id)}</span>
        <b>${esc(t.name)}</b>
        <span class="badge st-${esc(t.status)}">${STATUS_LABEL[t.status] ?? esc(t.status)}</span>
        <button class="detail-close" id="detail-close" title="关闭">×</button>
      </div>
      <div class="detail-line"><b>${esc(t.assignee ?? '未分配')}</b> · ${esc(waitText)}${member?.model ? ` · ${esc(member.model)}` : ''}</div>
      ${t.specPath ? `<div class="detail-line">规格: <b>${esc(t.specPath)}</b></div>` : ''}
      ${t.summary ? `<div class="detail-summary">${esc(t.summary)}</div>` : ''}
      <div class="detail-line">${esc(unlocksText)}${t.resultPath ? ` · 结果: <b>${esc(t.resultPath)}</b> ${artifact}` : ''}</div>
    </div>`;
    panel.classList.remove('hidden');
    $('detail-close').addEventListener('click', () => {
      pinnedTask = null;
      render();
    });
  }

  // ---------- 轮询 ----------

  async function refresh() {
    try {
      state = await fetchState();
      if (!selectedProject && state.project) selectedProject = state.project.id;
      const hash = JSON.stringify([
        state.project,
        state.captain,
        state.progress,
        state.pendingHint,
        state.members,
        state.workflow,
        state.error,
      ]);
      if (hash !== lastDataHash) {
        lastDataHash = hash;
        render();
      } else {
        $('updated').textContent = `更新于 ${new Date(state.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
      }
    } catch (e) {
      const banner = $('error-banner');
      banner.textContent = `面板服务不可达：${e.message}（panel 服务是否在运行？可用 /at-dashboard status 检查）`;
      banner.classList.remove('hidden');
      $('status-dot').className = 'dot error';
    }
  }

  $('project-select').addEventListener('change', (e) => {
    selectedProject = e.target.value || null;
    pinnedTask = null;
    refresh();
  });
  $('pause-btn').addEventListener('click', () => {
    paused = !paused;
    $('pause-btn').textContent = paused ? '继续' : '暂停';
    if (paused) {
      $('status-dot').classList.add('paused');
      clearInterval(timer);
    } else {
      refresh();
      startTimer();
    }
  });

  function startTimer() {
    clearInterval(timer);
    const sec = Math.max(2, Number(state?.config?.refreshSeconds) || 5);
    timer = setInterval(refresh, sec * 1000);
  }

  refresh().then(startTimer);
})();

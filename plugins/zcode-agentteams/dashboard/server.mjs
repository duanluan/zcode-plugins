#!/usr/bin/env node
// AgentTeams 活动面板本地服务：静态页面 + 数据聚合 API。
// 数据来源优先级：演示模式(--demo) > AgentTeams Controller（projects 模型）>
// HiClaw Controller（本地 Docker 部署的 teams/workers 模型）> agt CLI。
// 零依赖，Node ≥ 18。
//
// 用法：node server.mjs [--port 8712] [--demo] [--controller <url>] [--token <t>] [--team <t>] [--refresh <s>]
// 配置文件：~/.zcode-agentteams/config.json {controllerUrl, token, tokenFile, team, port, refreshSeconds, demo}
//   controllerUrl 支持 docker://<容器名>[@端口]（默认端口 8090）：服务每次请求前用 docker inspect 解析容器 IP，
//   避免 Docker 重启后容器 IP 漂移导致面板失联（HiClaw 的 controller 不映射宿主机端口）。
// 环境变量：AGENTTEAMS_CONTROLLER_URL / AGENTTEAMS_AUTH_TOKEN / AGENTTEAMS_AUTH_TOKEN_FILE /
//          AGENTTEAMS_TEAM / AGENTTEAMS_DASHBOARD_PORT / AGENTTEAMS_DASHBOARD_DEMO=1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildDemoState } from './demo.mjs';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DIR = path.join(os.homedir(), '.zcode-agentteams');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ---------- 配置 ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') args.demo = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--controller') args.controllerUrl = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--team') args.team = argv[++i];
    else if (a === '--refresh') args.refreshSeconds = Number(argv[++i]);
  }
  return args;
}

function readFileText(p) {
  if (!p) return null;
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

function loadConfig() {
  const file = (() => {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      return {};
    }
  })();
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));
  const token = args.token ?? env.AGENTTEAMS_AUTH_TOKEN ?? readFileText(file.tokenFile ?? '') ?? file.token ?? null;
  return {
    controllerUrl: (args.controllerUrl ?? env.AGENTTEAMS_CONTROLLER_URL ?? file.controllerUrl ?? '').replace(/\/+$/, ''),
    token,
    team: args.team ?? env.AGENTTEAMS_TEAM ?? file.team ?? null,
    port: args.port ?? (Number(env.AGENTTEAMS_DASHBOARD_PORT) || file.port || 8712),
    refreshSeconds: args.refreshSeconds ?? file.refreshSeconds ?? 5,
    demo: args.demo ?? (env.AGENTTEAMS_DASHBOARD_DEMO === '1' || file.demo === true),
    // 可选 Matrix 消息源 {homeserverUrl, user, passwordFile}：配置后面板在团队模式下
    // 额外拉取 Matrix 房间最近消息，让「在干啥」可读（controller 状态 API 不含聊天内容）
    matrix: file.matrix ?? null,
  };
}

// ---------- Matrix 消息流（可选） ----------

let mxToken = null;
let mxMsgCache = { at: 0, data: [] };

async function mxRequest(cfg, urlPath, retry = true) {
  if (!mxToken) {
    const password = readFileText(cfg.matrix.passwordFile);
    if (!password) throw new Error('Matrix 密码文件不可读');
    const res = await fetch(`${cfg.matrix.homeserverUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: cfg.matrix.user },
        password,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.access_token) throw new Error(`Matrix 登录失败（HTTP ${res.status}）`);
    mxToken = data.access_token;
  }
  const res = await fetch(`${cfg.matrix.homeserverUrl}${urlPath}`, {
    headers: { Authorization: `Bearer ${mxToken}` },
  });
  if (res.status === 401 && retry) {
    mxToken = null;
    return mxRequest(cfg, urlPath, false);
  }
  if (!res.ok) throw new Error(`Matrix HTTP ${res.status}`);
  return res.json();
}

// 拉全部已加入房间的最近文本消息，按时间倒序；30 秒内存缓存避免每次刷新都打 Matrix
async function fetchMatrixMessages(cfg) {
  if (!cfg.matrix?.homeserverUrl) return [];
  const now = Date.now();
  if (now - mxMsgCache.at < 30_000) return mxMsgCache.data;
  const joined = await mxRequest(cfg, '/_matrix/client/v3/joined_rooms');
  const enc = encodeURIComponent;
  const rooms = joined.joined_rooms ?? [];
  const perRoom = await Promise.all(
    rooms.map(async (roomId) => {
      const roomName = await mxRequest(cfg, `/_matrix/client/v3/rooms/${enc(roomId)}/state/m.room.name`)
        .then((d) => d.name ?? '')
        .catch(() => '');
      const chunk = await mxRequest(cfg, `/_matrix/client/v3/rooms/${enc(roomId)}/messages?limit=8&dir=b`)
        .then((d) => d.chunk ?? [])
        .catch(() => []);
      return chunk
        .filter((e) => e.type === 'm.room.message' && typeof e.content?.body === 'string' && !e.content.body.startsWith('!'))
        // conduit 是服务端桥接机器人，只发系统报错，不是团队对话
        .filter((e) => (e.sender ?? '').replace(/^@/, '').replace(/:.*$/, '') !== 'conduit')
        .map((e) => ({
          worker: (e.sender ?? '').replace(/^@/, '').replace(/:.*$/, ''),
          room: roomName || roomId,
          content: e.content.body,
          createdAt: e.origin_server_ts ? new Date(e.origin_server_ts).toISOString() : null,
        }));
    }),
  );
  const all = perRoom
    .flat()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 12);
  mxMsgCache = { at: now, data: all };
  return all;
}

// ---------- Controller / agt 数据获取 ----------

async function fetchJson(url, token, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function runAgt(args) {
  return new Promise((resolve, reject) => {
    execFile('agt', args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`agt 输出不是 JSON：${String(stdout).slice(0, 200)}`));
      }
    });
  });
}

// docker://<容器名>[@端口] → http://<容器IP>:<端口>（默认 8090），60s 缓存避免频繁 exec
const dockerIpCache = new Map();
async function resolveControllerUrl(url) {
  const m = String(url).match(/^docker:\/\/([^@]+?)(?:@(\d+))?$/);
  if (!m) return url;
  const [, name, port] = m;
  const key = `${name}@${port ?? 8090}`;
  const cached = dockerIpCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return `http://${cached.ip}:${port ?? 8090}`;
  try {
    const { stdout } = await execFileP(
      'docker',
      ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name],
      { timeout: 5000 }
    );
    const ip = stdout.trim().split(/\s+/)[0];
    if (!ip) throw new Error(`容器 ${name} 无可用 IP（是否在运行？）`);
    dockerIpCache.set(key, { ip, at: Date.now() });
    return `http://${ip}:${port ?? 8090}`;
  } catch (e) {
    dockerIpCache.delete(key);
    throw new Error(`docker:// 解析失败：${e.message}`);
  }
}

// ---------- 归一化 ----------

const STATUS_KEYS = new Set(['pending', 'delegated', 'in-progress', 'completed', 'revision', 'blocked']);

function normStatus(s) {
  const v = String(s ?? 'pending').toLowerCase().replace(/_/g, '-');
  if (STATUS_KEYS.has(v)) return v;
  if (v === 'done' || v === 'complete') return 'completed';
  if (v === 'running' || v === 'active') return 'in-progress';
  if (v === 'failed' || v === 'cancelled') return 'blocked';
  return 'pending';
}

function stripMatrixId(id) {
  const m = String(id ?? '').match(/@?([^:@]+)[:@]?/);
  return m ? m[1] : String(id ?? '');
}

function normProjects(json) {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.projects) ? json.projects : [];
  return arr.map((p) => ({
    id: p.project_id ?? p.id ?? p.name,
    title: p.title ?? p.project_id ?? p.id ?? '未命名项目',
    status: String(p.status ?? 'active'),
    planType: p.plan_type ?? p.planType ?? null,
    teamId: p.team_id ?? p.teamId ?? null,
  }));
}

function normWorkflow(json) {
  const w = json?.workflow ?? json;
  const nodes = (w?.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name ?? n.id,
    status: normStatus(n.status),
    assignee: n.assignee ?? n.assigned_to ?? null,
  }));
  const edges = (w?.edges ?? []).map((e) => ({
    source: e.source ?? e.from,
    target: e.target ?? e.to,
    conditional: Boolean(e.conditional),
  }));
  return {
    title: w?.title ?? null,
    status: String(w?.status ?? 'active'),
    planType: w?.plan_type ?? w?.planType ?? null,
    teamId: w?.team_id ?? w?.teamId ?? null,
    requester: w?.requester ?? null,
    sourceRoomId: w?.source_room_id ?? w?.sourceRoomId ?? null,
    nodes,
    edges,
    interrupts: w?.interrupts ?? [],
  };
}

function normTasks(json) {
  const arr = json?.tasks_detail ?? json?.tasks ?? [];
  const out = {};
  for (const t of arr) {
    out[t.task_id ?? t.id] = {
      id: t.task_id ?? t.id,
      name: t.spec_path ? path.basename(String(t.spec_path)) : (t.task_id ?? t.id),
      status: normStatus(t.status),
      assignee: t.assigned_to ? stripMatrixId(t.assigned_to) : null,
      specPath: t.spec_path ?? null,
      summary: t.summary ?? null,
      resultStatus: t.result_status ?? null,
      deliverables: Array.isArray(t.deliverables) ? t.deliverables.length : (t.deliverables ?? 0),
      resultPath: t.result_path ?? null,
      cancelReason: t.cancel_reason ?? null,
      blockedBy: [],
      unlocks: [],
    };
  }
  return out;
}

function normSpawns(json) {
  const workers = json?.workers ?? (Array.isArray(json) ? json : []);
  const out = [];
  for (const w of workers) {
    for (const s of w.spawns ?? []) {
      out.push({ worker: w.worker ?? w.name, sessionId: s.session_id ?? s.id, status: String(s.status ?? ''), name: s.name ?? null });
    }
  }
  return out;
}

function progressCounts(nodes) {
  const p = { running: 0, delegated: 0, pending: 0, completed: 0, revision: 0, blocked: 0, total: nodes.length };
  for (const n of nodes) p[n.status === 'in-progress' ? 'running' : n.status]++;
  return p;
}

function buildTasksIndex(wf, tasksRaw) {
  const tasks = { ...tasksRaw };
  // 节点补全任务详情里缺失的字段；依赖关系由边推导
  for (const n of wf.nodes) {
    tasks[n.id] = {
      id: n.id,
      name: n.name ?? n.id,
      status: n.status,
      assignee: n.assignee ? stripMatrixId(n.assignee) : (tasks[n.id]?.assignee ?? null),
      specPath: tasks[n.id]?.specPath ?? null,
      summary: tasks[n.id]?.summary ?? null,
      resultStatus: tasks[n.id]?.resultStatus ?? null,
      deliverables: tasks[n.id]?.deliverables ?? 0,
      resultPath: tasks[n.id]?.resultPath ?? null,
      cancelReason: tasks[n.id]?.cancelReason ?? null,
      blockedBy: wf.edges.filter((e) => e.target === n.id).map((e) => e.source),
      unlocks: wf.edges.filter((e) => e.source === n.id).map((e) => e.target),
    };
  }
  return tasks;
}

function buildMembers(wf, spawns) {
  const map = new Map();
  for (const n of wf.nodes) {
    const key = n.assignee ? stripMatrixId(n.assignee) : '未分配';
    if (!map.has(key)) map.set(key, { name: key, display: key, desc: null, model: null, tasks: [] });
    map.get(key).tasks.push({ id: n.id, name: n.name, status: n.status });
  }
  const runningWorkers = new Set(spawns.filter((s) => s.status === 'running').map((s) => s.worker));
  return [...map.values()].map((m) => {
    const done = m.tasks.filter((t) => t.status === 'completed').length;
    const runningTask = m.tasks.find((t) => t.status === 'in-progress');
    let status = 'waiting';
    if (runningTask || runningWorkers.has(m.name)) status = 'working';
    else if (done === m.tasks.length && m.tasks.length > 0) status = 'done';
    else if (m.tasks.some((t) => t.status === 'delegated')) status = 'delegated';
    return {
      ...m,
      done,
      total: m.tasks.length,
      status,
      runningTask: runningTask ? { id: runningTask.id, detail: null } : null,
    };
  });
}

function pendingHintText(wf) {
  const completed = new Set(wf.nodes.filter((n) => n.status === 'completed').map((n) => n.id));
  const unstaged = wf.nodes.filter((n) => {
    if (n.status !== 'pending' && n.status !== 'delegated') return false;
    const preds = wf.edges.filter((e) => e.target === n.id).map((e) => e.source);
    return preds.length > 0 && !preds.every((p) => completed.has(p));
  });
  if (unstaged.length === 0) return null;
  const ids = unstaged.map((n) => n.id);
  const head = ids.slice(0, 3).join('、');
  const rest = ids.length > 3 ? ` 等 ${ids.length} 项` : '';
  return `${head}${rest}等待布置，其余已开工`;
}

// ---------- 状态聚合 ----------

// HiClaw（AgentTeams 本地 Docker 发行版）控制面：teams/workers/humans/managers 模型，
// 无 tasks/projects API。归一化成面板通用结构：manager→队长、worker→成员、team→项目。
function hiclawWorkerStatus(w) {
  const s = String(w.phase ?? w.state ?? '').toLowerCase();
  if (/running|ready|working/.test(s)) return 'in-progress';
  if (/fail|error|crash|dead/.test(s)) return 'blocked';
  return 'pending';
}

function normHiClawMembers(workers) {
  return workers.map((w) => {
    const status = hiclawWorkerStatus(w);
    return {
      name: w.name ?? w.id ?? 'worker',
      display: w.name ?? w.id ?? 'worker',
      desc: w.description ?? (w.runtime ? `运行时 ${w.runtime}` : null),
      model: w.model ?? null,
      status: status === 'in-progress' ? 'working' : status === 'blocked' ? 'blocked' : 'waiting',
      done: 0,
      total: 0,
      runningTask: null,
      tasks: [],
    };
  });
}

async function fetchHiClawState(cfg, base, projectId) {
  const get = (ep) => fetchJson(`${base}/api/v1/${ep}`, cfg.token).catch(() => null);
  const [teamsR, workersR, humansR, managersR] = await Promise.all([
    get('teams'), get('workers'), get('humans'), get('managers'),
  ]);
  if (!teamsR && !workersR && !managersR) {
    return emptyState(cfg, '本地 Docker 控制面不可达或凭据无效（teams/workers/managers 全部失败）');
  }
  const teams = teamsR?.teams ?? [];
  const workers = workersR?.workers ?? [];
  const humans = humansR?.humans ?? [];
  const managers = managersR?.managers ?? [];
  const members = normHiClawMembers(workers);
  const executing = members.filter((m) => m.status === 'working').length;
  const manager = managers[0] ?? null;
  // 失败静默：消息流是增强能力，不打断状态展示、不进错误横幅
  const mxMessages = await fetchMatrixMessages(cfg).catch(() => []);

  // teams 为空（尚未建团队）时给一个合成项目，保证队长/成员视图可用
  const projects = teams.length
    ? teams.map((t) => ({
        id: t.name ?? t.id,
        title: t.name ?? '未命名团队',
        status: String(t.phase ?? t.state ?? 'active'),
        planType: null,
        teamId: t.name ?? t.id,
      }))
    : [{ id: 'default', title: `${manager?.name ?? 'manager'}（默认团队）`, status: 'active', planType: null, teamId: 'default' }];
  const current = projects.find((p) => p.id === projectId) ?? projects[0];

  return {
    config: { mode: 'hiclaw', controllerUrl: cfg.controllerUrl || null, team: cfg.team, refreshSeconds: cfg.refreshSeconds, demo: false },
    generatedAt: new Date().toISOString(),
    projects,
    project: {
      id: current.id,
      title: current.title,
      status: current.status,
      planType: null,
      teamId: current.teamId,
      memberCount: members.length + humans.length,
      taskTotal: 0,
      taskCompleted: 0,
      messageCount: mxMessages.length,
    },
    captain: manager
      ? {
          name: manager.name ?? 'manager',
          faction: manager.runtime ?? null,
          model: manager.model ?? null,
          dispatched: null,
          memberCount: members.length + humans.length,
          executing,
        }
      : null,
    progress: { running: 0, delegated: 0, pending: 0, completed: 0, revision: 0, blocked: 0, total: 0 },
    pendingHint: null,
    members,
    workflow: { nodes: [], edges: [] },
    tasks: {},
    interrupts: [],
    messages: mxMessages,
    hint:
      teams.length === 0
        ? '控制面已连接，但还没有团队/Worker：打开 Element Web（http://127.0.0.1:18088）让 Manager 建团队派任务。'
        : cfg.matrix
          ? '本地 Docker 控制面为团队/成员模型（无 tasks API），面板展示团队、成员实时状态与 Matrix 最近消息。'
          : '本地 Docker 控制面为团队/成员模型（无 tasks API）。配置 config.json 的 matrix 节点后可在此显示团队聊天内容。',
    error: null,
  };
}

const apiStyleCache = new Map(); // controller base → 'agentteams' | 'hiclaw'
let lastApiStyle = null; // 供 /api/config 汇报当前实际数据源风格

async function fetchState(cfg, projectId) {
  if (cfg.demo) return buildDemoState();

  const errors = [];
  let projects = [];
  let viaAgt = false;
  let base = null;
  if (cfg.controllerUrl) {
    try {
      base = await resolveControllerUrl(cfg.controllerUrl);
    } catch (e) {
      errors.push(e.message);
    }
    if (base) {
      let style = apiStyleCache.get(base);
      if (!style) {
        // teams 接口优先探测：v1.2.x controller 同时保留 projects 接口（可能恒为空），
        // 若先探 projects 会把 teams/workers 模型误判成项目模型，导致有团队也不显示
        try {
          await fetchJson(`${base}/api/v1/teams`, cfg.token);
          style = 'hiclaw';
        } catch (e) {
          try {
            await fetchJson(`${base}/api/v1/projects`, cfg.token);
            style = 'agentteams';
          } catch (e2) {
            errors.push(`Controller API：${e2.message}`);
          }
        }
        if (style) apiStyleCache.set(base, style);
      }
      if (style) lastApiStyle = style;
      if (style === 'hiclaw') return fetchHiClawState(cfg, base, projectId);
      if (style === 'agentteams') {
        try {
          projects = normProjects(await fetchJson(`${base}/api/v1/projects`, cfg.token));
        } catch (e) {
          errors.push(`Controller API：${e.message}`);
        }
      }
    }
  }
  if (projects.length === 0) {
    try {
      projects = normProjects(await runAgt(['get', 'projects', '-o', 'json']));
      viaAgt = true;
    } catch (e) {
      // Controller 在线时 agt 只是冗余回退，未装不算故障，不占用错误位
      if (!base) errors.push(/ENOENT/.test(e.message) ? 'agt CLI 未安装（可选）' : `agt CLI：${e.message}`);
    }
  }
  if (projects.length === 0) {
    if (base && lastApiStyle === 'agentteams') {
      return emptyState(cfg, '控制面已连接，但还没有团队/项目：打开 Manager 控制台（http://127.0.0.1:18888）派一个需要协作的任务（如「创建团队调研 xx」），Manager 建好团队/Worker 后这里就会显示实时活动。');
    }
    return emptyState(cfg, errors.length ? errors.join('；') : '未发现任何项目：请确认 AgentTeams Controller 已运行、config 已配置（/at-setup）。');
  }

  const current = projects.find((p) => p.id === projectId) ?? projects.find((p) => p.status === 'active') ?? projects[0];
  const q = (extra) => {
    const t = cfg.team ? `&team=${encodeURIComponent(cfg.team)}` : '';
    return extra + t;
  };

  let wf = null;
  let spawns = [];
  if (viaAgt) {
    try {
      wf = normWorkflow(await runAgt(['get', 'projects', current.id, '-o', 'json', ...(cfg.team ? ['--team', cfg.team] : [])]));
    } catch (e) {
      errors.push(`agt workflow：${e.message}`);
    }
  } else {
    try {
      wf = normWorkflow(
        await fetchJson(`${base}/api/v1/projects/${encodeURIComponent(current.id)}/workflow?includeTasks=true${q('')}`, cfg.token)
      );
    } catch (e) {
      errors.push(`workflow：${e.message}`);
    }
    try {
      spawns = normSpawns(
        await fetchJson(`${base}/api/v1/projects/${encodeURIComponent(current.id)}/spawns${q('')}`, cfg.token)
      );
    } catch {
      /* spawns 可选，失败不阻塞 */
    }
  }

  if (!wf) return emptyState(cfg, errors.join('；') || 'workflow 数据不可用');

  // 最近消息：取最多 3 个运行中会话的消息流（可选，失败忽略）
  const messages = [];
  if (!viaAgt && base) {
    const runningSessions = spawns.filter((s) => s.status === 'running').slice(0, 3);
    await Promise.all(
      runningSessions.map(async (s) => {
        try {
          const data = await fetchJson(
            `${base}/api/v1/projects/${encodeURIComponent(current.id)}/spawns/${encodeURIComponent(s.sessionId)}/messages?limit=10${q('')}`,
            cfg.token
          );
          for (const m of data.messages ?? []) {
            messages.push({ worker: s.worker, headline: m.headline ?? null, content: m.content ?? '', createdAt: m.created_at ?? null });
          }
        } catch {
          /* 忽略 */
        }
      })
    );
  }

  const tasks = buildTasksIndex(wf, normTasks(wf));
  const members = buildMembers(wf, spawns);
  const progress = progressCounts(wf.nodes);
  const executing = new Set(wf.nodes.filter((n) => n.status === 'in-progress').map((n) => (n.assignee ? stripMatrixId(n.assignee) : null)));
  for (const s of spawns) if (s.status === 'running') executing.add(s.worker);

  return {
    config: { mode: viaAgt ? 'agt' : 'controller', controllerUrl: cfg.controllerUrl || null, team: cfg.team, refreshSeconds: cfg.refreshSeconds, demo: false },
    generatedAt: new Date().toISOString(),
    projects,
    project: {
      id: current.id,
      title: wf.title ?? current.title,
      status: String(wf.status ?? current.status),
      planType: wf.planType ?? current.planType,
      teamId: wf.teamId ?? current.teamId ?? cfg.team,
      memberCount: members.length,
      taskTotal: wf.nodes.length,
      taskCompleted: progress.completed,
      messageCount: (wf.interrupts?.length ?? 0) + messages.length,
    },
    captain: {
      name: wf.requester ? stripMatrixId(wf.requester) : (wf.teamId ?? current.teamId ?? '队长'),
      faction: null,
      dispatched: wf.nodes.length,
      memberCount: members.length,
      executing: executing.size,
    },
    progress,
    pendingHint: pendingHintText(wf),
    members,
    workflow: { nodes: wf.nodes, edges: wf.edges },
    tasks,
    interrupts: wf.interrupts ?? [],
    messages: messages.slice(0, 8),
    error: errors.length ? { message: '部分数据源不可用', detail: errors.join('；') } : null,
  };
}

function emptyState(cfg, message) {
  return {
    config: { mode: cfg.controllerUrl ? 'controller' : 'none', controllerUrl: cfg.controllerUrl || null, team: cfg.team, refreshSeconds: cfg.refreshSeconds, demo: cfg.demo },
    generatedAt: new Date().toISOString(),
    projects: [],
    project: null,
    captain: null,
    progress: { running: 0, delegated: 0, pending: 0, completed: 0, revision: 0, blocked: 0, total: 0 },
    pendingHint: null,
    members: [],
    workflow: { nodes: [], edges: [] },
    tasks: {},
    interrupts: [],
    messages: [],
    error: { message, detail: null },
  };
}

// ---------- HTTP 服务 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, filePath) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readStateSafely(cfg, projectId) {
  try {
    return await fetchState(cfg, projectId);
  } catch (e) {
    const s = emptyState(cfg, e.message);
    s.error = { message: '数据获取失败', detail: String(e.stack || e.message) };
    return s;
  }
}

const cfg = loadConfig();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        mode: cfg.demo ? 'demo' : lastApiStyle ?? (cfg.controllerUrl ? 'controller' : 'none'),
        controllerUrl: cfg.controllerUrl || null,
        team: cfg.team,
        port: cfg.port,
        refreshSeconds: cfg.refreshSeconds,
        demo: cfg.demo,
        configFile: CONFIG_FILE,
      });
    }
    if (url.pathname === '/api/state') {
      return sendJson(res, 200, await readStateSafely(cfg, url.searchParams.get('project')));
    }
    if (url.pathname === '/api/artifact') {
      if (!cfg.controllerUrl) return sendJson(res, 400, { error: '未配置 Controller，无法下载工件' });
      const pid = url.searchParams.get('project');
      const tid = url.searchParams.get('task');
      const t = cfg.team ? `&team=${encodeURIComponent(cfg.team)}` : '';
      const upstream = await fetch(`${cfg.controllerUrl}/api/v1/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(tid)}/artifact?${t}`, {
        headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      });
      if (!upstream.ok) return sendJson(res, upstream.status, { error: `工件下载失败：HTTP ${upstream.status}` });
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${tid}-artifact"`,
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.end(buf);
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return serveStatic(res, file);
      }
      return sendJson(res, 404, { error: 'not found' });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e.stack || e.message) });
  }
});

fs.mkdirSync(CONFIG_DIR, { recursive: true });
server.listen(cfg.port, '127.0.0.1', () => {
  const mode = cfg.demo ? 'demo' : cfg.controllerUrl ? 'controller' : '未配置（将尝试 agt CLI）';
  console.log(`[agentteams-dashboard] http://127.0.0.1:${cfg.port}  数据源：${mode}`);
  console.log(`[agentteams-dashboard] 配置文件：${CONFIG_FILE}`);
});

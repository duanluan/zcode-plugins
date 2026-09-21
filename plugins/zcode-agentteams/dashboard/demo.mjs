// 演示数据：复刻 AgentTeams 活动面板的示例场景（attachment-overhaul 项目）。
// 无 Controller / agt 时用于验收界面与功能演示：`node server.mjs --demo`。
// 数据形状与 server.mjs 的 normalize 输出一致（state 聚合结构）。

const NODES = [
  { id: 't1', name: 'SDD 附件与文件板设计', status: 'completed', assignee: '@backend-designer:matrix.local' },
  { id: 't2', name: 'api-contract.md 附件契约', status: 'in-progress', assignee: '@contract-author:matrix.local' },
  { id: 't3', name: 'frontend/design.md 附件交互修订', status: 'pending', assignee: '@contract-author:matrix.local' },
  { id: 't4', name: '后端改动边界说明', status: 'pending', assignee: '@backend-designer:matrix.local' },
  { id: 't5', name: '运行时质量验证', status: 'in-progress', assignee: '@verifier:matrix.local' },
  { id: 't6', name: '附件模块改造', status: 'pending', assignee: '@attachment-impl:matrix.local' },
  { id: 't7', name: '附件通用接入 Service', status: 'pending', assignee: '@attachment-impl:matrix.local' },
  { id: 't8', name: '消息流集成验证', status: 'pending', assignee: '@verifier:matrix.local' },
  { id: 't9', name: '集成回归', status: 'pending', assignee: '@contract-author:matrix.local' },
  { id: 't10', name: '下载文档同步', status: 'pending', assignee: '@contract-author:matrix.local' },
];

const EDGES = [
  { source: 't1', target: 't2' },
  { source: 't1', target: 't3' },
  { source: 't2', target: 't4' },
  { source: 't3', target: 't4' },
  { source: 't3', target: 't10' },
  { source: 't4', target: 't5' },
  { source: 't5', target: 't6' },
  { source: 't5', target: 't8' },
  { source: 't6', target: 't7' },
  { source: 't7', target: 't9' },
  { source: 't8', target: 't9' },
  { source: 't9', target: 't10' },
];

const MEMBER_META = {
  'backend-designer': {
    desc: '后端设计与闸门作者：撰写 SDD 附件与文件板设计，并实现后端改动边界',
    model: 'deepseek-flash',
  },
  'contract-author': {
    desc: '契约与前端文档作者：撰写 api-contract.md 附件契约、frontend 设计与文档同步',
    model: 'deepseek-official/deepseek-flash',
  },
  'attachment-impl': {
    desc: '附件模块实现者：实现通用附件 Service 与 knowledge 库接入',
    model: 'deepseek-flash',
  },
  verifier: {
    desc: '独立验证者与收尾执行者：DDL 准备、运行时质量验证、集成收尾',
    model: 'deepseek-flash',
  },
};

const SUMMARY = {
  t1: '撰写 SDD：附件与文件板的总体设计、改动文件板与边界说明。',
  t2: '撰写 api-contract.md：附件上传/下载/预览接口契约与错误码约定。',
  t3: '修订 frontend/design.md：附件交互去 url 直链，统一走下载预览接口。',
  t4: '说明 D 后端改动边界：哪些模块允许改、哪些仅新增。',
  t5: '运行时质量验证：DDL 准备、用例执行与结果记录。',
  t6: '附件模块改造：抽离通用附件能力，收敛存储路径。',
  t7: '实现通用附件 Service：统一上传/下载/预览入口。',
  t8: '消息流集成验证：附件消息在会话流里的展示与回放。',
  t9: '集成回归：全链路用例回归与缺陷清单。',
  t10: '下载文档同步：更新使用文档与接口变更说明。',
};

export function buildDemoState() {
  const now = new Date().toISOString();
  const running = ['t2', 't5'];
  const members = ['backend-designer', 'contract-author', 'attachment-impl', 'verifier'].map((name) => {
    const tasks = NODES.filter((n) => n.assignee === `@${name}:matrix.local`);
    const done = tasks.filter((t) => t.status === 'completed').length;
    const runningTask = tasks.find((t) => running.includes(t.id));
    return {
      name,
      display: name,
      desc: MEMBER_META[name].desc,
      model: MEMBER_META[name].model,
      status: runningTask ? 'working' : done === tasks.length ? 'done' : 'waiting',
      done,
      total: tasks.length,
      runningTask: runningTask ? { id: runningTask.id, detail: MEMBER_META[name].model } : null,
      tasks: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status })),
    };
  });

  return {
    config: { mode: 'demo', controllerUrl: null, team: 'demo-team', refreshSeconds: 5, demo: true },
    generatedAt: now,
    projects: [
      { id: 'attachment-overhaul', title: 'attachment-overhaul', status: 'active', planType: 'dag', teamId: 'demo-team' },
    ],
    project: {
      id: 'attachment-overhaul',
      title: 'attachment-overhaul',
      status: 'active',
      planType: 'dag',
      teamId: 'demo-team',
      memberCount: members.length,
      taskTotal: NODES.length,
      taskCompleted: NODES.filter((n) => n.status === 'completed').length,
      messageCount: 1,
    },
    captain: { name: '小鲸', faction: '汇总', dispatched: NODES.length, memberCount: members.length, executing: 2 },
    progress: {
      running: 2,
      delegated: 0,
      pending: 7,
      completed: 1,
      revision: 0,
      blocked: 0,
      total: NODES.length,
    },
    pendingHint: 't3、t4、t6 等 7 项等待布置，其余已开工',
    members,
    workflow: { nodes: NODES, edges: EDGES },
    tasks: Object.fromEntries(
      NODES.map((n) => [
        n.id,
        {
          id: n.id,
          name: n.name,
          status: n.status,
          assignee: n.assignee.replace(/@([^:]+):.*/, '$1'),
          specPath: `plans/attachment-overhaul/${n.id}-${n.name.split(' ')[0]}.md`,
          summary: SUMMARY[n.id],
          resultStatus: n.status === 'completed' ? 'success' : null,
          deliverables: n.status === 'completed' ? 1 : 0,
          resultPath: n.status === 'completed' ? 'artifacts/t1/sdd.md' : null,
          blockedBy: EDGES.filter((e) => e.target === n.id).map((e) => e.source),
          unlocks: EDGES.filter((e) => e.source === n.id).map((e) => e.target),
        },
      ])
    ),
    interrupts: [{ node: 't2', kind: 'awaiting_input', headline: '契约评审等待队长确认' }],
    messages: [
      {
        worker: 'contract-author',
        headline: '正在执行 t2 · deepseek-official/deepseek-flash',
        content: '已完成接口草案的上传/下载部分，预览接口等待队长确认错误码约定。',
        createdAt: now,
      },
    ],
    error: null,
  };
}

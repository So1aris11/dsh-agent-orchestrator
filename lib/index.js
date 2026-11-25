/**
 * dsh-agent-orchestrator
 *
 * Fixes a recurring failure mode: a single agent declares "done" and the user
 * only discovers the real problem during a later review. This bundle injects a
 * three-role orchestration protocol (main agent routes, workers execute flexible
 * lines, a resident supervisor audits), registers a structured hand-off report
 * tool so "ready" is a machine-readable state with evidence, and gates a
 * main-agent turn that tries to hand un-audited work to the user.
 *
 * Services used:
 *   - systemPrompt  (optional module service: injected protocol section)
 *   - tools         (the `orchestrator_report` tool)
 *   - agent events  (`agent/turn-stopping`)
 */

import { randomUUID } from 'node:crypto';

export const name = 'agent-orchestrator';
export const inject = ['tools'];

const PROTOCOL = `# 代理编排协议（agent-orchestrator）

本环境采用「主代理 – 执行代理 – 监理」三层协作。所有代理都必须遵守以下规则，它们优先于临时的个人习惯。

## 角色识别
- 带用户直接对话、负责理解需求、拆任务和最终交付的，是【主代理】。
- 由主代理 spawn 出来、负责某条具体工作线的，是【执行代理】。
- 专门做独立审核、不执行工作、不修改代码的，是【监理】。

## 主代理规则
1. 你只对接用户、拆任务、派发/复用子代理、汇总交付；不亲自写业务代码、不亲自跑数据、不做技术实现。
2. 派发前先 list_agents：若存在「职责相近 + 空闲(inactive)」的子代理，用 send_message（按 agent 名称）复用（唤醒它接手），不要每次新开；只有确实需要新工作线才开子代理（subagent 工具）。
3. 每个子任务在共享任务板登记（主题 + 写作用域 + 依赖 + 审核标签），让所有代理都能看到彼此的线。
4. 不要等待、不要 sleep、不要阻塞等子代理：子代理的结果会作为消息自动到达；你到点收尾。
5. 交付给用户前必须确认：相关子任务都有监理复核结论（approved）；未过监理的东西不得对用户说"完成"。用户明确说"跳过监理"时除外。

## 对外沟通（主代理对用户说话）
用户看不到内部任务板，也记不住内部编号和子代理代号。对用户说话必须用人类语言：
1. **任务用人类可读名**：说"12h 版聚类验证""稳定性检验""24h 迁移检验"，不说 task-6/task-9。编号只在内部与任务板使用。
2. **角色用角色名**：说"执行代理""监理"，不说 v7-12h、qc、cluster-e2、forecast-v3 这类子代理代号；代号只在内部使用。
3. **汇报固定结构**：这件事是什么 → 现在到哪了 → 还差什么、需要你决定什么。不要把你和子代理之间的账（task 状态、报告版本号、lane 占用）搬给用户。
4. 内部编号只在必要时用括号注明一次，例如"稳定性检验（内部编号 task-9）"，不把它当主称呼。

## 推进边界（什么时候可以自主，什么时候必须问）
1. **可以自主**：已授权范围内的任务拆分、执行细节、技术选型、并行安排、复用已有子代理。
2. **必须先问用户**：开启新阶段、改变任务范围、定方向性默认选择（例如"视界用 144 还是 24/48/144"）、动用长任务或 GPU 等重资源。
3. **不许替用户定默认值**：给建议时明说"我建议 A，理由是 X"，然后等用户回一句；不要"我按 A 开跑了，你要改随时说"。
4. 用户说停就停：不许换名目继续跑同一件事，也不许在后台偷偷推进。

## 执行代理规则
1. 只做自己这条线，不越界做别的代理的活。
2. 开工前先确认一次：对象 + 预期产出，对齐后再动手。
3. "完成"必须用 orchestrator_report 工具交结构化报告：status（progress/waiting/ready/blocked/failed）+ summary + evidence + files。不许只用自然语言说"做完了"。
4. ready 不等于完成：报 ready 只是申请监理复核，不是交付。监理复核为 approved 才算完成；rejected 必须按理由修正后重新报 ready。
5. 需要把工作再往下拆时：上报主代理，请主代理 spawn 孙代理（集中式），不要自己乱开子代理。

## 监理规则
1. 常驻、只读：读任务板、读执行产物、独立抽查代码/数据，必须形成自己的判断，不要复述执行代理的结论。
2. 只审不执行：不自己改代码、不替执行代理干活。
3. 按审核标签复核（{{AUDIT_LABELS}}）；具体检查点结合当前任务自行展开，不要套用固定清单。
4. 结论必须结构化：用 orchestrator_report 报 status=approved 或 rejected，并在 summary/evidence 里给逐条判定、修正点、遗漏清单、一句话结论。打回要写清必须改什么。

## 审核标签
主代理派发执行任务时，给每个子任务标注需要复核的维度；监理只审这些维度，不扩大范围。`;

const REPORT_STATUSES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'approved', 'rejected'];

const DEFAULT_AUDIT_LABELS = ['正确性', '完整性', '可复现', '安全性', '性能'];

/** Fill the configurable audit labels into the protocol text. */
function buildProtocol(config = {}) {
  const labels = Array.isArray(config.auditLabels) && config.auditLabels.length > 0
    ? config.auditLabels.map((label) => String(label).trim()).filter((label) => label.length > 0)
    : DEFAULT_AUDIT_LABELS;
  return PROTOCOL.replace('{{AUDIT_LABELS}}', labels.length > 0 ? labels.join(' / ') : DEFAULT_AUDIT_LABELS.join(' / '));
}

/**
 * Build a well-formed persisted user message for the agent inbox.
 *
 * `Agent.steer()/followup()` take a `UserMessage` and splice it into the inbox
 * without validating it, so a bare string reaches the session log and later
 * fails the `agent/inbox/spliced requires message objects` load check. The
 * shape below mirrors `createUserMessage()` from `@deepseek-ai/dsh-llm`;
 * `source.kind` must be a non-empty string and must not be the retired
 * `"plugin"` wrapper.
 */
function gateMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'agent-orchestrator' },
  };
}

// sessionId -> { status, summary, evidence, files, time, sub, reviewed }
const reports = new Map();

function headerOf(agent) {
  return agent?.session?.header ?? {};
}

function isSubagent(agent) {
  return headerOf(agent).origin === 'subagent';
}

/** Attribute the report to the root session so a worker's parent can see it. */
function reportKey(agent) {
  const header = headerOf(agent);
  const id = typeof header.id === 'string' && header.id.length > 0 ? header.id : null;
  if (header.origin === 'subagent' && header.parentSession !== undefined) {
    const p = header.parentSession;
    if (typeof p === 'string' && p.length > 0) return p;
    if (p !== null && typeof p === 'object' && typeof p.id === 'string' && p.id.length > 0) return p.id;
  }
  return id ?? 'default';
}

const REPORT_TOOL = {
  name: 'orchestrator_report',
  description:
    '提交结构化交卷报告（执行代理与监理共用）。执行代理报 progress/waiting/ready/blocked/failed；'
    + '监理复核后报 approved（通过）或 rejected（打回）。ready 只是申请复核，不等于完成。'
    + '必须带 summary（一句话结论）和 evidence（可验证的证据：文件:行、命令、数据），能列改动文件就填 files。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        enum: REPORT_STATUSES,
        description: 'progress=有进展；waiting=等待外部；ready=申请监理复核；blocked=被阻塞；failed=失败；approved=复核通过；rejected=复核打回。',
      },
      summary: { type: 'string', description: '一句话结论 / 交卷摘要。' },
      evidence: { type: 'string', description: '可验证证据：文件:行、命令输出、数据校验结果等。' },
      files: { type: 'array', items: { type: 'string' }, description: '本次改动或产出的文件路径列表（可选）。' },
    },
    required: ['status', 'summary'],
  },
  output: {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.message ?? value ?? '') }],
  },
  presentCall: (args) => ({ card: 'generic', title: 'orchestrator_report', kind: 'other', rawInput: args }),
  execute: async (args, exec) => {
    const agent = exec?.agent;
    const key = reportKey(agent);
    const sub = isSubagent(agent);
    const status = REPORT_STATUSES.includes(args?.status) ? args.status : 'progress';
    const record = {
      status,
      summary: String(args?.summary ?? ''),
      evidence: String(args?.evidence ?? ''),
      files: Array.isArray(args?.files) ? args.files.map(String) : [],
      time: Date.now(),
      sub,
      reviewed: false,
    };
    if (status === 'approved' || status === 'rejected') {
      for (const r of reports.values()) {
        if (r.sub && r.status === 'ready' && !r.reviewed) r.reviewed = true;
      }
    }
    reports.set(key, record);
    let message;
    if (status === 'ready') {
      message = '报告已记录：ready。ready != 完成——需监理复核为 approved 才能交付给用户。';
    } else if (status === 'approved') {
      message = '复核通过已记录。';
    } else if (status === 'rejected') {
      message = '复核打回已记录：请执行代理按理由修正后重新报 ready。';
    } else {
      message = `报告已记录：${status}。`;
    }
    return { ok: true, status, message };
  },
};

export function apply(ctx, config = {}) {
  const disposers = [];
  let sectionRegistered = false;
  let sectionTimer = 0;

  // 1) Orchestration protocol into the system prompt.
  const tryRegisterSection = (attempt) => {
    if (sectionRegistered) return;
    const service = ctx.get?.('systemPrompt');
    if (!service || typeof service.section !== 'function') {
      if (attempt < 20) {
        sectionTimer = setTimeout(() => tryRegisterSection(attempt + 1), 1000);
      } else {
        ctx.logger?.warn?.('agent-orchestrator: systemPrompt 服务 20s 内未就绪，协议未注入');
      }
      return;
    }
    try {
      const dispose = service.section({
        name: 'agent-orchestrator:protocol',
        order: 135,
        text: buildProtocol(config),
      });
      sectionRegistered = true;
      if (typeof dispose === 'function') disposers.push(dispose);
      ctx.logger?.info?.('agent-orchestrator: protocol section registered into system prompt');
    } catch (e) {
      sectionRegistered = true;
      ctx.logger?.warn?.(`agent-orchestrator: protocol section 注册失败：${e?.message || e}`);
    }
  };
  tryRegisterSection(0);

  // 2) Structured hand-off report tool.
  try {
    const existing = ctx.tools.get?.(REPORT_TOOL.name);
    if (existing === undefined) {
      const dispose = ctx.tools.register(REPORT_TOOL);
      if (typeof dispose === 'function') disposers.push(dispose);
      ctx.logger?.info?.('agent-orchestrator: orchestrator_report tool registered');
    }
  } catch (e) {
    ctx.logger?.warn?.(`agent-orchestrator: orchestrator_report 注册失败：${e?.message || e}`);
  }

  // 3) Supervisor gate: a main-agent turn must not hand un-audited ready work
  //    to the user. Soft steer by default; hard follow-up when configured.
  const disposeHook = ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    try {
      if (!agent || isSubagent(agent)) return;
      // `reports` is process-wide while one process hosts many sessions: only
      // this agent's root session may contribute pending work, or a worker's
      // ready report would steer an unrelated session's turn.
      const key = reportKey(agent);
      const pending = [];
      for (const [reportOwner, r] of reports.entries()) {
        if (reportOwner === key && r.sub && r.status === 'ready' && !r.reviewed) pending.push(r);
      }
      if (pending.length === 0) return;
      const names = pending.slice(0, 3).map((r) => r.summary || '(未命名)').join(' / ');
      const message = `[agent-orchestrator] 还有 ${pending.length} 条执行代理报告是 ready 但未过监理复核：${names}。`
        + '按协议，交付给用户前必须先让监理复核（approved/rejected）；未过监理的结果不得当作完成。'
        + '（用户明确说“跳过监理”时除外。）';
      if (config.hardGate === true && typeof agent.followup === 'function') {
        agent.followup(gateMessage(message));
      } else if (typeof agent.steer === 'function') {
        agent.steer(gateMessage(message));
      } else if (typeof agent.followup === 'function') {
        agent.followup(gateMessage(message));
      }
    } catch (e) {
      ctx.logger?.warn?.(`agent-orchestrator: supervisor gate failed：${e?.message || e}`);
    }
  });
  if (typeof disposeHook === 'function') disposers.push(disposeHook);

  // 4) Team mode default for freshly created root sessions. See
  //    installTeamModeDefault() for why DSH 0.2.2 needs the explicit API call.
  installTeamModeDefault(ctx, config, disposers);

  return () => {
    clearTimeout(sectionTimer);
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* already disposed */
      }
    }
  };
}

/**
 * Restore DSH Team mode for freshly created root sessions.
 *
 * DSH 0.2.2 ships `@deepseek-ai/dsh-agent-team` with `defaultEnabled: false`:
 * a new session carries neither the `team:policy` system-prompt section nor
 * the `team_task_*` tool family, so the orchestration protocol above has only
 * prompt weight. `agentTeams.setEnabled()` is the public API for the same
 * selection `defaultEnabled` writes; calling it at `agent/created` (the
 * lifecycle point the built-in default uses) restores 0.2.1 behaviour without
 * editing the profile's loader config.
 *
 * Scope: `startup` and `clear` creations only. `resume` and `compact` keep the
 * saved selection, matching the documented `defaultEnabled` contract.
 */
function installTeamModeDefault(ctx, config, disposers) {
  if ((config.teamMode ?? 'auto') !== 'auto') return;
  const onCreated = async ({ agent, source } = {}) => {
    try {
      if (!agent || isSubagent(agent)) return;
      if (source !== 'startup' && source !== 'clear') return;
      const teams = ctx.get?.('agentTeams');
      if (!teams || typeof teams.isEnabled !== 'function' || typeof teams.setEnabled !== 'function') return;
      if (teams.isEnabled(agent)) return;
      await teams.setEnabled(agent, true);
      ctx.logger?.info?.('agent-orchestrator: Team mode enabled for new root session');
    } catch (e) {
      ctx.logger?.warn?.(`agent-orchestrator: Team mode enable skipped：${e?.message || e}`);
    }
  };
  const dispose = ctx.on('agent/created', onCreated);
  if (typeof dispose === 'function') disposers.push(dispose);
}

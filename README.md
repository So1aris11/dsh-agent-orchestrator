# dsh-agent-orchestrator

A [DeepSeek Harness](https://www.deepseek.com/en/harness/) (DSH) bundle that fixes a common multi-agent failure mode:

> **An agent says "done", and the user only discovers the real problem during a later review.**

It injects a three-role orchestration protocol into every session's system prompt, gives worker agents a structured hand-off report tool, and gates a main-agent turn that tries to hand un-audited work to the user.

## The three roles

| Role | Does |
|---|---|
| **Main agent** | Talks to the user, splits work, dispatches or reuses workers, aggregates results. Does **not** write business code or run data itself. |
| **Worker** | Owns one flexible line of work, confirms the target before starting, and hands off with `ready` + evidence. |
| **Supervisor** | A resident, read-only auditor. Audits by dimension, never executes, never edits code. |

**`ready` is not `done`.** A worker reporting `ready` only applies for supervisor audit. The result reaches the user only after the supervisor reports `approved`.

## What it adds

1. **Protocol section** in the system prompt (`agent-orchestrator:protocol`, order 135).
2. **`orchestrator_report` tool** — status `progress / waiting / ready / blocked / failed / approved / rejected`, with `summary` + `evidence` + `files`.
3. **Supervisor gate** on `agent/turn-stopping` — a main-agent turn that would hand un-audited `ready` work to the user is steered back (soft by default, hard with `hardGate: true`).

## Install

Requires a DSH profile with Agent Teams enabled.

From the profile directory (`~/.dsh/profiles/<name>`):

```bash
pnpm add "link:/path/to/dsh-agent-orchestrator"
```

Then add `"dsh-agent-orchestrator"` to `package.json` → `dsh.profile.bundles` and restart the host.

## Configure

All config is optional:

| Key | Default | Meaning |
|---|---|---|
| `auditLabels` | `['正确性','完整性','可复现','安全性','性能']` | Audit dimensions the supervisor reviews. Override for your domain, e.g. quant: `['未来信息泄露','可复现','结果正确性']`. |
| `hardGate` | `false` | `false` = soft steer; `true` = forced follow-up turn. |

Example `cordis.patch.yml` entry in a profile:

```yaml
- id: agent-orchestrator
  name: "dsh-agent-orchestrator"
  config:
    auditLabels: ["future-leak", "reproducibility", "correctness"]
    hardGate: false
```

## Note

The protocol references Agent Teams tools (`spawn_teammate`, `team_task_*`, `send_message`). Without Agent Teams the bundle still loads, but those rules have nothing to act on.

## License

MIT

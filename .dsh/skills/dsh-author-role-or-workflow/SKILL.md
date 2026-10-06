---
name: dsh-author-role-or-workflow
description: 在 DSH 中创建或修改通用角色，或设计一个需要多角色协调的 workflow skill 时使用。帮助判断职责应放在角色、项目层还是 workflow 中，并提供安全的配置与验证清单。触发词：新建角色、修改角色、设计 workflow、编写 workflow skill。
---

# 编写 DSH 角色或 Workflow Skill

角色定义的是可版本化的能力；workflow skill 定义多个角色之间的依赖和治理。先判断边界，再写配置。

## 1. 先判断放在哪里

- 只有一个角色完成任务：把通用方法和通用场景写进角色 YAML。
- 需要项目背景、项目专属场景或额外校验：把这些放进项目层，而不是污染通用角色。
- 必须协调多个角色时才创建 workflow skill，通常是两种依赖：
  - 数据依赖：角色 B 消费角色 A 的产出；
  - 治理依赖：角色 B 必须独立检查或审批角色 A 的结果。

不要把单角色场景硬做成 workflow，也不要把多角色交接塞进一个角色的 system prompt。

## 2. 角色文件

角色可以使用简洁的旧格式，也可以使用可长期维护的新格式。新格式的最小骨架如下：

```yaml
api_version: dsh.orchestrator/v1alpha1
kind: Role
metadata:
  role_id: example-role
  name: Example role
  version: 1.0.0
  description: A reusable role description
  annotations:
    dsh.when_to_use: When this role is appropriate

system_prompt: |
  Describe the role's responsibilities and working method.

capabilities:
  - code-generation

execution:
  harness: codex
  keep_alive_after_task: false
  chat_timeout_ms: 900000
  interaction_mode: headless
  tool_request:
    file_operations: [read, list]
    shell_commands:
      - pnpm test
  sandbox: read-only

scenarios:
  - name: review
    title: Review a change
    when: The task asks for an independent review.
    guidance: Inspect the change, run relevant checks, and report evidence.

contract:
  input:
    type: object
    required: [task_description]
  output:
    format: markdown
    required_sections: [Summary, Evidence]

verification:
  - type: output_structure
    config:
      required_sections: [Summary, Evidence]
```

Use `packages/spec/src/role.ts` and the schema validator as the authoritative field reference. Keep role content generic:
do not embed private paths, credentials, account information, host-specific instructions or internal project history.

## 3. Project layers

A project layer targets a role and adds only host-specific context, scenarios or verification rules. Keep it in the host
project's private configuration. Do not copy it into a reusable public framework export.

## 4. Workflow skills

A workflow skill contains a `SKILL.md` for the human/agent-facing instructions. A governed workflow can additionally
contain `dsh/pack.yaml` and `dsh/workflow.yaml`.

Useful workflow fields include:

- `spec.workspace.setup`: preparation commands run in each worktree;
- `steps[].scenario`: the selected role scenario;
- `steps[].paths`: paths the step is allowed to change;
- `steps[].checks`: argv-form checks executed by the runner;
- `policy.allow_no_changes`: whether a writing step may finish without a diff.

Use `${{ inputs.<name> }}` for workflow inputs. Keep setup and checks deterministic and free of secrets. A workflow
should not silently broaden permissions; requested harnesses, tools, file operations, shell commands and sandbox modes
must still pass the project policy.

## 5. Policy and safety

Treat `execution.tool_request` and `sandbox` as requests, not grants. The host policy must intersect them with an
allowlist. Start from `.dsh/policy.yaml.example`, copy it to `.dsh/policy.yaml`, and explicitly allow only the harnesses,
tools, file operations, shell patterns and sandbox modes the project needs. Do not place machine paths or MCP credentials
in a role, workflow skill or public repository.

Only harness, sandbox mode and MCP servers are enforced today: list each one explicitly, and use `[]` to prohibit a
category (an agent that needs it then does not start). A role that declares no sandbox gets the first allowed mode. An omitted field allows everything, and so does a missing policy
file — a development fallback, not a security boundary. File-operation and shell-pattern allowlists are checked against a
role's declarations and recorded as violations, but they do not limit what the agent's tools can do; bound that with the
sandbox mode.

## 6. Validation checklist

1. Validate the role document and its scenario names.
2. Confirm the role's requested capabilities are allowed by the host policy.
3. Compile a workflow with `pnpm dsh:start-workflow --list` or a dry run.
4. Run focused role/schema/workflow tests, then the full test suite for shared changes.
5. Review the diff for private role names, project paths, internal documents, logs, credentials and unneeded history.

Keep only history that explains a current public contract or safety decision. Remove task numbers, incident notes and
private project chronology that do not help a user operate the framework.

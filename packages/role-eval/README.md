# @dsh/role-eval

`@dsh/role-eval` compares two versions of the same agent role on the same task.
Each arm starts from the same Git base in an isolated worktree, receives the
same visible checks, and can be scored with hidden checks after the role leaves.
The package records observable evidence rather than trusting a role's report.

## What It Provides

- role sources from a Git ref or a directory;
- manifest parsing and reproducible arm ordering;
- isolated setup, agent execution, visible checks and hidden checks;
- journal metrics and a comparison record;
- blinded evidence bundles for a separate evaluator.

The package does not ship role definitions, project layers, workflow packs or
evaluation records. Those are host-project content and should remain private.

## Minimal Manifest

```yaml
id: role-comparison
title: Compare a role revision
role: example-role
base_commit: 0123456789abcdef0123456789abcdef01234567
timeout_ms: 900000
sandbox: workspace-write
instructions: |
  Complete the task and report the result.
checks:
  - name: tests
    command: pnpm test
hidden_checks:
  - name: contract
    command: pnpm build
```

`hidden_checks` are installed and run after the role's candidate commit is
captured. They should assert the contract or observable behavior, not a
particular source-file layout.

## CLI

The repository-level scripts expose the package through these commands:

```bash
pnpm dsh:compare-roles <manifest> \
  --baseline git:<ref> \
  --candidate <roles-directory> \
  --dry-run

pnpm dsh:eval-bundle <comparison-record> --phase rubric --blind
pnpm dsh:eval-bundle <comparison-record> --phase grade --blind
```

Use `--dry-run` while authoring a manifest. A live comparison can start real
harness processes and consume model quota. Keep output directories under the
runtime area, which is excluded from source control by default.

## Scoring Model

The comparison record keeps separate readings for delivery, correctness,
cost and (when implemented) repeated-run stability. It intentionally avoids a
weighted total: users can decide how to trade correctness, time and tool use
for their own workload.

For reproducibility, pin the base commit, use the same setup and checks for
both arms, record the seed when arm order is randomized, and keep the role and
project-layer hashes in the evidence.

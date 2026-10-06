import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/test/**/*.test.ts'],
    // `.dsh/eval/tasks/*.hidden/` holds hidden acceptance tests for role
    // comparisons. They are written against a *past* state of this repo and
    // are staged into a throwaway worktree at scoring time (@dsh/role-eval);
    // running them against the working tree is meaningless, and their
    // `../src/…` imports do not even resolve from where they are stored.
    // Setting `exclude` replaces vitest's defaults, which skip `.git/`; a
    // governed run's integration worktree lives under
    // `.git/dsh-orchestrator/integration/<runId>/` and holds a full copy of
    // these tests (seen during testing: 29 spurious failures).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**', '.dsh/eval/tasks/**'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/spec/src/**/*.ts',
        'packages/communication/src/**/*.ts',
        'packages/comm-eventbus/src/**/*.ts',
        'packages/orchestrator/src/**/*.ts',
        'packages/agent-manager/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/workspace-git/src/**/*.ts',
        'packages/role-eval/src/**/*.ts',
      ],
      // behavior (resolved during testing): communication.ts/role.ts are pure interface/type
      // declarations with no executable statements — same case as **/src/types.ts, just not
      // matched by that glob because of their filenames. Excluded explicitly rather than
      // renamed, to avoid a repo-wide import churn for a coverage-accounting fix.
      exclude: [
        '**/src/index.ts',
        '**/src/types.ts',
        '**/src/channel/generated/**',
        // Pure interface/type declarations with zero executable statements — v8 coverage
        // reports these as 0% for having nothing to execute, not for lacking tests. Same
        // category as **/src/types.ts, just under different filenames. skill-snapshot.ts and
        // workflow-skill.ts (added after new interface modules) are exactly the recurrence behavior
        // warned would keep happening as @dsh/spec grows; add the next one here too rather
        // than reopening the debt.
        'packages/spec/src/communication.ts',
        'packages/spec/src/role.ts',
        'packages/spec/src/skill-snapshot.ts',
        'packages/spec/src/workflow-skill.ts',
        // Same misjudgment found outside packages/spec while auditing this list: a barrel
        // re-export (no statements of its own, same category as **/src/index.ts) and a
        // pure-interface file (same category as **/src/types.ts) under different filenames.
        'packages/communication/src/compatibility.ts',
        'packages/communication/src/internal-types.ts',
        // **/src/types.ts and **/src/index.ts only match directly under a package's src/ root
        // — they miss the same pure files one level deeper (src/<module>/types.ts,
        // src/<module>/index.ts). Each of these was read in full and confirmed to hold zero
        // executable statements before being added; siblings with real logic under the same
        // names (packages/agent-manager/src/{client,channel,policy,role}/{index,types}.ts,
        // packages/core/src/run/types.ts) were deliberately left covered — those do carry real
        // functions/classes/consts and a 0% there would be a genuine gap, not a misjudgment.
        'packages/core/src/repository/types.ts',
        'packages/core/src/verification/types.ts',
        'packages/core/src/verification/index.ts',
        'packages/core/src/workflow/types.ts',
        'packages/agent-manager/src/policy/index.ts',
        'packages/agent-manager/src/journal/types.ts',
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
      },
    },
  },
})

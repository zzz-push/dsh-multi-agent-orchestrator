import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DshAgentManagerConfigSchema,
  expandHome,
  PLUGIN_CHECKOUT_ROOT,
  resolveAgentManagerPaths,
} from '../src/config.js'

const checkout = '/checkout'
const home = '/home/me'
const resolve = (config: unknown) => resolveAgentManagerPaths(DshAgentManagerConfigSchema.parse(config), checkout, home)

describe('agent-manager plugin paths', () => {
  it('finds the checkout it runs from, whatever the process working directory is', () => {
    // Role packs are supplied by a host project and are intentionally absent
    // from the framework export.
    expect(existsSync(path.join(PLUGIN_CHECKOUT_ROOT, 'packages', 'agent-manager', 'package.json'))).toBe(true)
  })

  it('resolves the defaults against the checkout, not the process working directory', () => {
    expect(resolve({})).toEqual({
      root: '/checkout',
      rolesDir: '/checkout/.dsh/roles',
      journalFile: '/checkout/.dsh/runtime/agent-events.jsonl',
      cwd: '/checkout',
      claudeCommand: 'claude',
      codexCommand: 'codex',
    })
  })

  it('resolves relative values against root, keeps absolute ones, and expands ~/', () => {
    expect(resolve({
      root: 'nested',
      rolesDir: 'roles',
      journalFile: '/var/log/events.jsonl',
      cwd: '~/work',
      codexHome: '.dsh/runtime/codex-home',
      claudeCommand: '~/.local/bin/claude',
      codexCommand: './bin/codex',
    })).toEqual({
      root: '/checkout/nested',
      rolesDir: '/checkout/nested/roles',
      journalFile: '/var/log/events.jsonl',
      cwd: '/home/me/work',
      codexHome: '/checkout/nested/.dsh/runtime/codex-home',
      claudeCommand: '/home/me/.local/bin/claude',
      codexCommand: '/checkout/nested/bin/codex',
    })
    expect(resolve({ root: '~/elsewhere' }).root).toBe('/home/me/elsewhere')
  })

  it('leaves bare command names for PATH lookup', () => {
    expect(resolve({ claudeCommand: 'claude-beta', codexCommand: '/opt/codex' })).toMatchObject({ claudeCommand: 'claude-beta', codexCommand: '/opt/codex' })
  })

  it('expands only a leading ~ or ~/', () => {
    expect(expandHome('~', home)).toBe(home)
    expect(expandHome('~/a', home)).toBe('/home/me/a')
    expect(expandHome('~other/a', home)).toBe('~other/a')
    expect(expandHome('a/~/b', home)).toBe('a/~/b')
  })
})

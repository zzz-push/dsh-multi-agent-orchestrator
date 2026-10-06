import { access, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Checker, VerificationContext, VerificationResult } from '../types.js'

/** Configuration for checking files relative to the verification workspace. */
export interface ArtifactExistsConfig {
  files: string[]
}

/** Checks that declared artifacts exist inside the verification workspace. */
export class ArtifactExistsChecker implements Checker {
  readonly type: 'artifact_exists' = 'artifact_exists'

  async check(
    context: VerificationContext,
    config: Record<string, unknown>,
  ): Promise<VerificationResult> {
    const cfg = (config ?? {}) as unknown as ArtifactExistsConfig
    const rule = { type: this.type, config }

    if (cfg.files === undefined) {
      return {
        rule,
        passed: true,
        message: '没有需要检查的文件',
      }
    }
    if (!Array.isArray(cfg.files)) {
      return {
        rule,
        passed: false,
        message: 'files 必须是字符串数组',
      }
    }
    if (cfg.files.length === 0) {
      return {
        rule,
        passed: true,
        message: '没有需要检查的文件',
      }
    }
    if (cfg.files.some((file) => typeof file !== 'string')) {
      return {
        rule,
        passed: false,
        message: 'files 必须是字符串数组',
      }
    }

    const missingFiles: string[] = []
    const unsafeFiles: string[] = []
    const workspaceRoot = resolve(context.cwd)
    const canonicalRoot = await this.resolveCanonicalRoot(workspaceRoot)

    for (const file of cfg.files) {
      if (!this.isSafeRelativeReference(file)) {
        unsafeFiles.push(file)
        continue
      }

      const filePath = resolve(workspaceRoot, file)
      if (!this.isWithin(workspaceRoot, filePath)) {
        unsafeFiles.push(file)
        continue
      }

      // Resolve existing symlinks before checking containment. A lexical path
      // can appear inside cwd while its symlink target escapes the workspace.
      const canonicalPath = await this.resolveCanonicalPath(filePath)
      if (canonicalPath !== undefined && !this.isWithin(canonicalRoot, canonicalPath)) {
        unsafeFiles.push(file)
        continue
      }

      if (canonicalPath === undefined || !(await this.fileExists(filePath))) {
        missingFiles.push(file)
      }
    }

    if (unsafeFiles.length > 0 || missingFiles.length > 0) {
      const details: Record<string, unknown> = { missingFiles }
      if (unsafeFiles.length > 0) details.unsafeFiles = unsafeFiles
      const labels = [...missingFiles, ...unsafeFiles]
      return {
        rule,
        passed: false,
        message: `缺少文件: ${labels.join(', ')}`,
        details,
      }
    }

    return {
      rule,
      passed: true,
      message: `所有 ${cfg.files.length} 个文件都存在`,
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath)
      return true
    } catch {
      return false
    }
  }

  private async resolveCanonicalRoot(workspaceRoot: string): Promise<string> {
    try {
      return await realpath(workspaceRoot)
    } catch {
      // A missing cwd means every artifact is missing; retaining the lexical
      // root keeps the result deterministic and avoids leaking fs errors.
      return workspaceRoot
    }
  }

  private async resolveCanonicalPath(filePath: string): Promise<string | undefined> {
    try {
      return await realpath(filePath)
    } catch {
      return undefined
    }
  }

  private isSafeRelativeReference(file: string): boolean {
    if (file.length === 0 || file.includes('\0')) return false

    // Reject explicit parent segments even when they happen to resolve back
    // inside cwd. This keeps role declarations auditable and blocks traversal.
    const segments = file.split(/[\\/]+/)
    if (segments.some((segment) => segment === '..')) return false

    // Absolute paths are allowed only when they remain inside cwd; the caller
    // still gets the same containment check after resolution.
    return true
  }

  private isWithin(root: string, candidate: string): boolean {
    const child = relative(root, candidate)
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  }
}

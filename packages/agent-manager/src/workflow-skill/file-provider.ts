import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'

import type {
  DiscoveredWorkflowSkill,
  WorkflowSkillProvider,
  WorkflowSkillSummary,
} from '@dsh/spec'

import { InvalidWorkflowSkillError } from '../errors.js'

interface WorkflowPackManifest {
  entry: string
  workflowId: string
  version?: string
}

interface WorkflowSkillFrontmatter {
  name: string
  description: string
  disableModelInvocation: boolean
}

/** Configuration for a file-backed workflow Skill Pack provider. */
export interface FileWorkflowSkillProviderOptions {
  /** Directory whose immediate child directories are scanned as Skill Packs. */
  skillsDir: string
  /** Optional warning sink used when `list()` skips an invalid Pack. */
  logger?: {
    /** Record a non-fatal discovery warning. */
    warn(message: string): void
  }
}

/**
 * Workflow Skill provider that scans immediate children of `.dsh/skills/`.
 *
 * Each operation re-reads the files so edits are visible without cache
 * invalidation. Discovery isolates invalid Packs, while an explicitly requested
 * invalid Pack fails with {@link InvalidWorkflowSkillError}.
 */
export class FileWorkflowSkillProvider implements WorkflowSkillProvider {
  private readonly skillsDir: string
  private readonly logger?: { warn(message: string): void }

  constructor(options: FileWorkflowSkillProviderOptions) {
    this.skillsDir = path.resolve(options.skillsDir)
    this.logger = options.logger
  }

  /** List valid workflow Packs, warning and continuing past invalid Packs. */
  async list(): Promise<WorkflowSkillSummary[]> {
    const summaries: WorkflowSkillSummary[] = []
    for (const packPath of await this.packDirectories()) {
      // A directory without `dsh/pack.yaml` is an ordinary Skill (guidance
      // for the harness), not a workflow Pack: nothing to list, nothing to warn
      // about. A manifest that exists but is broken still gets a warning.
      if (!(await hasManifest(packPath))) continue
      try {
        const manifestDocument = await this.readManifestDocument(packPath)
        if (manifestDocument['dsh.kind'] !== 'workflow') continue
        summaries.push(toSummary(await this.loadPack(packPath, manifestDocument)))
      } catch (error) {
        this.logger?.warn(`Skipping workflow Skill Pack "${packPath}": ${errorMessage(error)}`)
      }
    }
    summaries.sort((left, right) => left.workflowId.localeCompare(right.workflowId))
    return summaries
  }

  /**
   * Load a workflow Pack by its declared id.
   *
   * Invalid unrelated Packs do not prevent lookup. If an invalid manifest cannot
   * expose its declared id, its directory name is used only to decide whether it
   * is the Pack explicitly requested by the caller.
   */
  async get(workflowId: string): Promise<DiscoveredWorkflowSkill | undefined> {
    for (const packPath of await this.packDirectories()) {
      let manifestDocument: Record<string, unknown>
      try {
        manifestDocument = await this.readManifestDocument(packPath)
      } catch (error) {
        if (path.basename(packPath) === workflowId) throw error
        continue
      }

      if (manifestDocument['dsh.kind'] !== 'workflow') continue
      const declaredWorkflowId = manifestDocument['dsh.workflowId']
      if (declaredWorkflowId !== workflowId) {
        if (path.basename(packPath) !== workflowId) continue
        return this.loadPack(packPath, manifestDocument)
      }
      return this.loadPack(packPath, manifestDocument)
    }
    return undefined
  }

  private async packDirectories(): Promise<string[]> {
    try {
      const entries = await readdir(this.skillsDir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.skillsDir, entry.name))
        .sort()
    } catch {
      return []
    }
  }

  private async readManifestDocument(packPath: string): Promise<Record<string, unknown>> {
    const manifestPath = path.join(packPath, 'dsh', 'pack.yaml')
    const source = await readTextFile(manifestPath, packPath, 'dsh/pack.yaml')
    const raw = parseDocument(source, packPath, 'dsh/pack.yaml')
    if (!isRecord(raw)) {
      throw invalidPack(packPath, 'dsh/pack.yaml must contain a YAML object')
    }
    return raw
  }

  private async loadPack(
    packPath: string,
    manifestDocument: Record<string, unknown>,
  ): Promise<DiscoveredWorkflowSkill> {
    const manifest = validateManifest(manifestDocument, packPath)
    const frontmatter = await readSkillFrontmatter(packPath)
    const entryPath = await resolveContainedEntry(packPath, manifest.entry)
    const workflowSource = await readTextFile(entryPath, packPath, manifest.entry)
    const rawWorkflow = parseDocument(workflowSource, packPath, manifest.entry)
    const localRolesDir = await findLocalRolesDir(packPath)

    return {
      workflowId: manifest.workflowId,
      name: frontmatter.name,
      description: frontmatter.description,
      disableModelInvocation: frontmatter.disableModelInvocation,
      version: manifest.version,
      rawManifest: manifestDocument,
      packPath,
      rawWorkflow,
      localRolesDir,
    }
  }
}

function validateManifest(
  raw: Record<string, unknown>,
  packPath: string,
): WorkflowPackManifest {
  requireString(raw['dsh.apiVersion'], packPath, 'dsh.apiVersion', 'dsh/pack.yaml')
  const entry = requireString(raw['dsh.entry'], packPath, 'dsh.entry', 'dsh/pack.yaml')
  const workflowId = requireString(
    raw['dsh.workflowId'],
    packPath,
    'dsh.workflowId',
    'dsh/pack.yaml',
  )
  const version = optionalString(raw['dsh.version'], packPath, 'dsh.version', 'dsh/pack.yaml')
  return { entry, workflowId, version }
}

async function readSkillFrontmatter(packPath: string): Promise<WorkflowSkillFrontmatter> {
  const skillPath = path.join(packPath, 'SKILL.md')
  const source = await readTextFile(skillPath, packPath, 'SKILL.md')
  const lines = source.split(/\r?\n/)
  if (lines[0] !== '---') {
    throw invalidPack(packPath, 'SKILL.md must start with a --- frontmatter delimiter')
  }
  const closingIndex = lines.indexOf('---', 1)
  if (closingIndex < 0) {
    throw invalidPack(packPath, 'SKILL.md frontmatter is missing its closing --- delimiter')
  }
  const raw = parseDocument(lines.slice(1, closingIndex).join('\n'), packPath, 'SKILL.md')
  if (!isRecord(raw)) throw invalidPack(packPath, 'SKILL.md frontmatter must be a YAML object')

  return {
    name: requireString(raw.name, packPath, 'name', 'SKILL.md frontmatter'),
    description: requireString(
      raw.description,
      packPath,
      'description',
      'SKILL.md frontmatter',
    ),
    disableModelInvocation: optionalBoolean(
      raw['disable-model-invocation'],
      packPath,
      'disable-model-invocation',
      'SKILL.md frontmatter',
    ) ?? true,
  }
}

async function resolveContainedEntry(packPath: string, entry: string): Promise<string> {
  const segments = entry.split('/')
  const invalid = path.isAbsolute(entry)
    || path.win32.isAbsolute(entry)
    || entry.includes('\\')
    || entry.includes('\0')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  if (invalid) {
    throw invalidPack(
      packPath,
      `dsh.entry must be a normalized relative POSIX path inside the Pack: "${entry}"`,
    )
  }

  const entryPath = path.resolve(packPath, entry)
  if (!isContainedPath(packPath, entryPath)) {
    throw invalidPack(packPath, `dsh.entry escapes the Pack directory: "${entry}"`)
  }

  let realPackPath: string
  let realEntryPath: string
  try {
    [realPackPath, realEntryPath] = await Promise.all([realpath(packPath), realpath(entryPath)])
  } catch (error) {
    throw invalidPack(packPath, `cannot resolve dsh.entry "${entry}": ${errorMessage(error)}`, error)
  }
  if (!isContainedPath(realPackPath, realEntryPath)) {
    throw invalidPack(packPath, `dsh.entry resolves outside the Pack directory: "${entry}"`)
  }
  return realEntryPath
}

async function findLocalRolesDir(packPath: string): Promise<string | undefined> {
  const rolesDir = path.join(packPath, 'dsh', 'roles')
  try {
    return (await stat(rolesDir)).isDirectory() ? rolesDir : undefined
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw invalidPack(packPath, `cannot inspect dsh/roles: ${errorMessage(error)}`, error)
  }
}

async function hasManifest(packPath: string): Promise<boolean> {
  return stat(path.join(packPath, 'dsh', 'pack.yaml')).then((info) => info.isFile(), () => false)
}

async function readTextFile(
  filePath: string,
  packPath: string,
  label: string,
): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    throw invalidPack(packPath, `cannot read ${label}: ${errorMessage(error)}`, error)
  }
}

function parseDocument(source: string, packPath: string, label: string): unknown {
  try {
    return parseYaml(source)
  } catch (error) {
    throw invalidPack(packPath, `${label} YAML parse failed: ${errorMessage(error)}`, error)
  }
}

function requireString(
  value: unknown,
  packPath: string,
  field: string,
  source: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidPack(packPath, `${source} field ${field} must be a non-empty string`)
  }
  return value
}

function optionalString(
  value: unknown,
  packPath: string,
  field: string,
  source: string,
): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, packPath, field, source)
}

function optionalBoolean(
  value: unknown,
  packPath: string,
  field: string,
  source: string,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw invalidPack(packPath, `${source} field ${field} must be a boolean`)
  }
  return value
}

function isContainedPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative)
}

function invalidPack(
  packPath: string,
  message: string,
  cause?: unknown,
): InvalidWorkflowSkillError {
  return new InvalidWorkflowSkillError(packPath, message, { cause })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toSummary(skill: DiscoveredWorkflowSkill): WorkflowSkillSummary {
  return {
    workflowId: skill.workflowId,
    name: skill.name,
    description: skill.description,
    disableModelInvocation: skill.disableModelInvocation,
    version: skill.version,
  }
}

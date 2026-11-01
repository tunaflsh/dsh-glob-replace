/**
 * Glob-scoped search and replace for DeepSeek Harness.
 *
 * One tool call rewrites every file matching a path glob. Changes are applied
 * through `ctx.fs` (resolve → observe → write-intent → write), so the sandbox,
 * the read-before-write observation policy, the workspace-changes capture, and
 * the atomic-write path all apply exactly as they do for `edit`/`write`.
 *
 * The tool returns per-file replacement counts and a unified diff, so a bulk
 * rewrite is as traceable in the transcript as a single edit.
 *
 * @module dsh-glob-replace
 */
import { isAbsolute, relative, sep } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-glob-replace'

/** Services used by the tool. */
export const inject = ['tools', 'fs', 'workingDirectory']

const DEFAULT_MAX_FILES = 100
const HARD_MAX_FILES = 500
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const MAX_REPLACEMENTS_PER_FILE = 5000
const MAX_BRACE_EXPANSIONS = 256
const MAX_WALK_DEPTH = 64
const DIFF_CONTEXT = 3
/** Directories never descended into; globs that name them are still unmatched. */
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '.bzr', '.jj', '.sl', 'node_modules', '.pnpm-store'])
/** Rendering bounds: the model gets a bounded diff, not the whole rewrite. */
const MAX_RENDER_LINES = 800
const MAX_RENDER_CHARS = 60_000
const MAX_META_BYTES = 512 * 1024

/* ------------------------------------------------------------------ globs */

/** Escape one regular-expression metacharacter. */
function escapeRegExp(character) {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character
}

/**
 * Expand the first balanced `{a,b}` group into alternatives.
 * @param {string} pattern - glob pattern.
 * @param {number} budget - maximum number of alternatives.
 * @returns {string[]} expanded patterns.
 */
export function expandBraces(pattern, budget = MAX_BRACE_EXPANSIONS) {
  const start = pattern.indexOf('{')
  if (start < 0) return [pattern]
  let depth = 0
  let end = -1
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === '{') depth += 1
    else if (pattern[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) return [pattern]
  const body = pattern.slice(start + 1, end)
  const parts = []
  let inner = 0
  let last = 0
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '{') inner += 1
    else if (character === '}') inner -= 1
    else if (character === ',' && inner === 0) {
      parts.push(body.slice(last, index))
      last = index + 1
    }
  }
  parts.push(body.slice(last))
  const head = pattern.slice(0, start)
  const tail = pattern.slice(end + 1)
  const expanded = []
  for (const part of parts) {
    for (const candidate of expandBraces(head + part + tail, budget)) {
      expanded.push(candidate)
      if (expanded.length >= budget) return expanded
    }
  }
  return expanded
}

/**
 * Translate one brace-free glob into a regular expression source.
 * `**` spans directories, `*` and `?` stay inside one segment, `[...]` copies a
 * character class, and a pattern without `/` matches the basename at any depth.
 * @param {string} pattern - glob pattern.
 * @returns {RegExp} anchored matcher over slash-separated relative paths.
 */
function globSource(pattern) {
  const anchored = pattern.includes('/')
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (character === '?') source += '[^/]'
    else if (character === '[') {
      let cursor = index + 1
      let body = ''
      if (pattern[cursor] === '!' || pattern[cursor] === '^') {
        body += '^'
        cursor += 1
      }
      let closed = false
      for (; cursor < pattern.length; cursor += 1) {
        const inner = pattern[cursor]
        if (inner === ']') {
          closed = true
          break
        }
        if (inner === '\\') {
          body += '\\\\'
          continue
        }
        body += inner
      }
      if (closed) {
        source += `[${body}]`
        index = cursor
      } else source += '\\['
    } else source += escapeRegExp(character)
  }
  return new RegExp(anchored ? `^${source}$` : `(?:^|.*/)${source}$`)
}

/**
 * Compile a glob (with braces) into one predicate over relative paths.
 * @param {string} pattern - glob pattern.
 * @returns {(path: string) => boolean} matcher.
 */
export function compileGlob(pattern) {
  const normalized = pattern.startsWith('./') ? pattern.slice(2) : pattern
  const matchers = expandBraces(normalized).map(globSource)
  return (path) => matchers.some((matcher) => matcher.test(path))
}

/* ------------------------------------------------------------------ replace */

/** Convert platform separators to `/`. */
function toPosix(path) {
  return path.split(sep).join('/')
}

/** Escape one regular-expression metacharacter for literal use. */
function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile the replacement matcher.
 * @param {string} pattern - literal text or regular-expression source.
 * @param {boolean} literal - whether `pattern` is fixed text.
 * @returns {{ kind: 'literal'|'regex', value: string, regex?: RegExp }} matcher.
 */
export function compileMatcher(pattern, literal) {
  if (literal) return { kind: 'literal', value: pattern }
  let regex
  try {
    regex = new RegExp(pattern, 'g')
  } catch (error) {
    throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { kind: 'regex', value: pattern, regex }
}

/**
 * Count matches without mutating `lastIndex` on the caller's matcher.
 * @param {string} text - file content.
 * @param {ReturnType<typeof compileMatcher>} matcher - compiled matcher.
 * @returns {number} match count.
 * @throws when a regular expression matches an empty string.
 */
export function countMatches(text, matcher) {
  if (matcher.kind === 'literal') {
    if (matcher.value.length === 0) return 0
    let count = 0
    let index = text.indexOf(matcher.value)
    while (index !== -1) {
      count += 1
      index = text.indexOf(matcher.value, index + matcher.value.length)
      if (count > MAX_REPLACEMENTS_PER_FILE) break
    }
    return count
  }
  matcher.regex.lastIndex = 0
  let count = 0
  for (const match of text.matchAll(matcher.regex)) {
    if (match[0].length === 0) {
      matcher.regex.lastIndex = 0
      throw new Error('pattern matches an empty string; anchor or tighten it')
    }
    count += 1
    if (count > MAX_REPLACEMENTS_PER_FILE) break
  }
  matcher.regex.lastIndex = 0
  return count
}

/**
 * Apply every replacement.
 * @param {string} text - file content.
 * @param {ReturnType<typeof compileMatcher>} matcher - compiled matcher.
 * @param {string} replacement - replacement text (regex `$1` references work).
 * @returns {string} rewritten content.
 */
export function replaceAll(text, matcher, replacement) {
  if (matcher.kind === 'literal') {
    if (matcher.value.length === 0) return text
    return text.split(matcher.value).join(replacement)
  }
  matcher.regex.lastIndex = 0
  const rewritten = text.replace(matcher.regex, replacement)
  matcher.regex.lastIndex = 0
  return rewritten
}

/* --------------------------------------------------------------------- diff */

/** Dynamic-programming LCS on two small line arrays. */
function lcsOps(left, right) {
  const rows = left.length + 1
  const columns = right.length + 1
  const table = new Int32Array(rows * columns)
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        left[row] === right[column]
          ? table[(row + 1) * columns + column + 1] + 1
          : Math.max(table[(row + 1) * columns + column], table[row * columns + column + 1])
    }
  }
  const operations = []
  let row = 0
  let column = 0
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      operations.push({ type: ' ', text: left[row] })
      row += 1
      column += 1
    } else if (table[(row + 1) * columns + column] >= table[row * columns + column + 1]) {
      operations.push({ type: '-', text: left[row] })
      row += 1
    } else {
      operations.push({ type: '+', text: right[column] })
      column += 1
    }
  }
  while (row < left.length) {
    operations.push({ type: '-', text: left[row] })
    row += 1
  }
  while (column < right.length) {
    operations.push({ type: '+', text: right[column] })
    column += 1
  }
  return operations
}

/**
 * Line diff with context, capped by a DP budget and a middle-block fallback.
 * @param {string} before - old content.
 * @param {string} after - new content.
 * @param {number} context - unchanged lines around each hunk.
 * @returns {Array<{ oldStart: number, oldCount: number, newStart: number, newCount: number, lines: string[] }>} hunks.
 */
export function diffHunks(before, after, context = DIFF_CONTEXT) {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const cells = (oldLines.length + 1) * (newLines.length + 1)
  if (cells <= 4_000_000) {
    return groupHunks(lcsOps(oldLines, newLines), 0, context)
  }
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let tail = 0
  while (
    tail < oldLines.length - prefix &&
    tail < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1
  const middleOld = oldLines.slice(prefix, oldLines.length - tail)
  const middleNew = newLines.slice(prefix, newLines.length - tail)
  if (middleOld.length === 0 && middleNew.length === 0) return []
  const start = Math.max(0, prefix - context)
  const endOld = Math.min(oldLines.length, oldLines.length - tail + context)
  const endNew = Math.min(newLines.length, newLines.length - tail + context)
  const lines = []
  for (let index = start; index < prefix; index += 1) lines.push(` ${oldLines[index]}`)
  for (const line of middleOld) lines.push(`-${line}`)
  for (const line of middleNew) lines.push(`+${line}`)
  for (let index = oldLines.length - tail; index < endOld; index += 1) lines.push(` ${oldLines[index]}`)
  return [{
    oldStart: start + 1,
    oldCount: endOld - start,
    newStart: start + 1,
    newCount: endNew - start,
    lines,
  }]
}

/** Group an operation list into hunks with `context` unchanged lines around each change. */
function groupHunks(operations, base, context) {
  const changed = []
  for (let index = 0; index < operations.length; index += 1) if (operations[index].type !== ' ') changed.push(index)
  if (changed.length === 0) return []
  const ranges = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(operations.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }
  return ranges.map((range) => {
    const lines = []
    let oldCount = 0
    let newCount = 0
    for (let index = range.start; index <= range.end; index += 1) {
      const operation = operations[index]
      lines.push(`${operation.type}${operation.text}`)
      if (operation.type !== '+') oldCount += 1
      if (operation.type !== '-') newCount += 1
    }
    const oldStart = base + 1 + offsetOf(operations, range.start, 'old')
    const newStart = base + 1 + offsetOf(operations, range.start, 'new')
    return { oldStart, oldCount, newStart, newCount, lines }
  })
}

/** Lines of one side consumed before `end` in the operation list. */
function offsetOf(operations, end, side) {
  let offset = 0
  for (let index = 0; index < end; index += 1) {
    const type = operations[index].type
    if (side === 'old' ? type !== '+' : type !== '-') offset += 1
  }
  return offset
}

/* --------------------------------------------------------------------- walk */

/**
 * Recursively list regular files under a target without following directory
 * cycles. VCS metadata and package stores are pruned.
 * @param {object} ctx - plugin context providing `fs`.
 * @param {object} root - resolved directory target.
 * @param {AbortSignal} signal - cancellation.
 * @returns {AsyncGenerator<object>} file entries.
 */
async function* walkFiles(ctx, root, signal) {
  const visited = new Set([root.targetKey])
  const stack = [{ target: root, depth: 0 }]
  while (stack.length > 0) {
    const { target, depth } = stack.pop()
    if (signal.aborted) throw new Error('glob_replace aborted')
    if (depth > MAX_WALK_DEPTH) continue
    let entries
    try {
      entries = await ctx.fs.listDir(target, signal)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.type === 'file') yield entry
      else if (entry.type === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue
        const key = entry.target.targetKey
        if (visited.has(key)) continue
        visited.add(key)
        stack.push({ target: entry.target, depth: depth + 1 })
      }
    }
  }
}

/* ----------------------------------------------------------------- sandbox */

/*
 * The escalation vocabulary below mirrors `@deepseek-ai/dsh-sandbox` (the
 * module `write`/`edit`/bash use). It is duplicated rather than imported so
 * this plugin keeps zero runtime dependencies and still reuses the exact
 * approval choreography, denial markers, and model-facing texts. Keep it in
 * sync with the harness version this plugin targets.
 */

/** Modes a call may escalate TO; `read-only` is the floor. */
const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']

/** The strictly-wider ladder, checked at execution rather than in the schema. */
const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/** Reject a malformed escalation request: the pair travels together. */
function validateEscalationArgs(sandboxPermissions, justification) {
  if (sandboxPermissions !== undefined && justification === undefined)
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  if (justification !== undefined && sandboxPermissions === undefined)
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  if (justification !== undefined && justification.trim().length === 0)
    throw new Error('invalid justification: expected a non-empty sentence')
}

/** The model-facing denial marker shared by bash, write, and edit. */
function sandboxDenialMarker(mode) {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** The same-turn hint that rides a denial when escalation is advertised. */
function escalationHintMarker(subject) {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/** Model-facing parameter description for `sandbox_permissions`. */
function sandboxPermissionsDescription(subject) {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`
}

/** Localized approval prompt text; audit inputs stay verbatim. */
function escalationDisplayReason(mode, justification) {
  return {
    en: `Allow this operation with ${mode} permissions: ${justification}`,
    zh: `允许本次操作使用 ${mode} 权限：${justification}`,
    ja: `${mode} 権限でこの操作を許可します：${justification}`,
    es: `Permitir esta operación con permisos ${mode}: ${justification}`,
    fr: `Autoriser cette opération avec les permissions ${mode} : ${justification}`,
    de: `Diesen Vorgang mit ${mode}-Berechtigungen zulassen: ${justification}`,
    ru: `Разрешить эту операцию с правами ${mode}: ${justification}`,
    pt: `Permitir esta operação com permissões ${mode}: ${justification}`,
  }
}

/**
 * Resolve a `sandbox_permissions` request before anything executes:
 * repeating the effective mode passes through, a strictly wider mode asks the
 * approval channel first, and every other outcome fails closed.
 */
async function approveEscalation(request, approval) {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (mode === effectiveMode) return effectiveMode
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode))
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  if (approval.approver === undefined)
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  if (approval.agent === undefined)
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    displayReason: escalationDisplayReason(mode, justification),
    ...(approval.signal === undefined ? {} : { signal: approval.signal }),
  })
  switch (outcome) {
    case 'allowed-once':
      return mode
    case 'rejected':
      throw new Error(
        `the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`,
      )
    case 'cancelled':
      throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable':
      throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default:
      throw new Error(`unexpected approval outcome: ${String(outcome)}`)
  }
}

/**
 * The filesystem-sandbox escalation surface for one plugin instance. Fields
 * are advertised only when the mounted filesystem confines; the per-call
 * policy is the Session's standing mode unless an approved wider retry is
 * stamped for this one call.
 */
function createSandboxController(ctx) {
  const defaultMode = ctx.fs.sandboxMode
  const escalationModes = defaultMode === undefined ? [] : [...ESCALATION_TARGETS]
  const policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && policy === undefined)
    throw new Error('glob-replace: the mounted filesystem confines but ctx.sandboxPolicy is missing')
  return {
    escalationModes,
    /** The two escalation parameter specs, present only under a confining backend. */
    schemaFields() {
      return {
        sandbox_permissions: {
          type: 'string',
          enum: [...escalationModes],
          description: sandboxPermissionsDescription('operation'),
        },
        justification: {
          type: 'string',
          description:
            'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access. Use the language of the user’s current request.',
        },
      }
    },
    /** Resolve this call's policy, asking approval before a wider retry. */
    async resolvePolicy(toolName, args, exec) {
      const standingPolicy = policy?.resolve({ ...(exec.agent === undefined ? {} : { session: exec.agent.session }) })
      if (args.sandbox_permissions !== undefined && args.sandbox_permissions === standingPolicy?.mode) return standingPolicy
      const justification =
        args.sandbox_permissions === undefined && args.justification?.trim() === '' ? undefined : args.justification
      validateEscalationArgs(args.sandbox_permissions, justification)
      if (args.sandbox_permissions === undefined || justification === undefined) return standingPolicy
      if (escalationModes.length === 0)
        throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
      const approvedMode = await approveEscalation(
        {
          requestedMode: args.sandbox_permissions,
          justification,
          effectiveMode: standingPolicy.mode,
          subject: 'operation',
        },
        {
          approver: ctx.get('approval'),
          agent: exec.agent,
          callId: exec.callId,
          toolName,
          signal: exec.signal,
        },
      )
      return { ...standingPolicy, mode: approvedMode }
    },
  }
}

/* ------------------------------------------------------------------- tool */

/** Validate and normalize tool arguments. */
function parseInput(args) {
  if (typeof args.glob !== 'string' || args.glob.trim() === '') throw new Error('glob must be a non-empty string')
  if (isAbsolute(args.glob)) throw new Error('glob must be relative to the search root')
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (typeof args.replacement !== 'string') throw new Error('replacement must be a string')
  if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim() === '')) throw new Error('path must be a non-empty string when given')
  if (args.exclude !== undefined) {
    if (!Array.isArray(args.exclude) || args.exclude.some((entry) => typeof entry !== 'string' || entry === ''))
      throw new Error('exclude must be an array of non-empty strings')
    if (args.exclude.length > 32) throw new Error('exclude accepts at most 32 patterns')
  }
  if (args.literal !== undefined && typeof args.literal !== 'boolean') throw new Error('literal must be a boolean')
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') throw new Error('dry_run must be a boolean')
  const maxFiles = args.max_files ?? DEFAULT_MAX_FILES
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > HARD_MAX_FILES)
    throw new Error(`max_files must be an integer between 1 and ${HARD_MAX_FILES}`)
  const maxFileBytes = args.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) throw new Error('max_file_bytes must be a positive integer')
  return {
    glob: args.glob,
    pattern: args.pattern,
    replacement: args.replacement,
    path: args.path,
    exclude: args.exclude ?? [],
    literal: args.literal === true,
    dryRun: args.dry_run === true,
    maxFiles,
    maxFileBytes,
  }
}

/** One-line error text. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Keep the diff payload inside the result budget; the file list stays complete. */
function boundDiffs(diffs) {
  const kept = []
  let bytes = 0
  let truncated = false
  for (const diff of diffs) {
    const size = diff.before.length + diff.after.length
    if (kept.length >= 100 || bytes + size > MAX_META_BYTES) {
      truncated = true
      continue
    }
    kept.push(diff)
    bytes += size
  }
  return { kept, truncated }
}

/** Render the model-facing summary plus a bounded diff. */
function renderResult(args, value) {
  const lines = []
  const verb = value.dry_run ? 'would change' : 'changed'
  lines.push(
    `glob_replace: ${verb} ${value.files_changed} of ${value.files_considered} file(s), ${value.replacements} replacement(s)` +
      (value.truncated ? ` — stopped at max_files (${args?.max_files ?? DEFAULT_MAX_FILES}); narrow the glob` : ''),
  )
  for (const file of value.files) {
    if (file.status === 'changed' || file.status === 'would-change') lines.push(`M ${file.path} (${file.replacements})`)
    else if (file.status === 'skipped' || file.status === 'error') lines.push(`! ${file.path}: ${file.message ?? file.status}`)
  }
  const diffs = value.diffs
  if (diffs.length > 0) {
    lines.push('')
    let emitted = 0
    let characters = lines.join('\n').length
    for (const diff of diffs) {
      const hunks = diffHunks(diff.before, diff.after)
      const header = `--- ${diff.path}`
      if (characters + header.length > MAX_RENDER_CHARS || emitted >= MAX_RENDER_LINES) break
      lines.push(header)
      characters += header.length
      for (const hunk of hunks) {
        const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
        lines.push(hunkHeader)
        characters += hunkHeader.length
        for (const line of hunk.lines) {
          if (emitted >= MAX_RENDER_LINES || characters + line.length > MAX_RENDER_CHARS) {
            lines.push('… diff truncated; the per-file counts above are complete')
            return lines.join('\n')
          }
          lines.push(line)
          characters += line.length
          emitted += 1
        }
      }
    }
  }
  return lines.join('\n')
}

/**
 * Register `glob_replace` in the calling composition.
 * @param {object} ctx - plugin context with `tools`, `fs`, and `workingDirectory`.
 */
export function apply(ctx) {
  const sandbox = createSandboxController(ctx)
  const tool = {
    name: 'glob_replace',
    description:
      'Replace a regular expression (or an exact string with `literal: true`) in every file matching a path glob, in one call. ' +
      'Use this instead of sed/awk/python for bulk edits: every write goes through the harness filesystem (read-before-write, sandbox, atomic write), ' +
      'and the result reports each changed file with a diff. ' +
      'Regex mode uses JavaScript syntax and replaces globally; `$1`, `$&` references work in `replacement`. ' +
      'Paths are relative to the session working directory by default; `.git`, other VCS metadata, and `node_modules` are never searched. ' +
      `Defaults: max_files ${DEFAULT_MAX_FILES}, max_file_bytes ${DEFAULT_MAX_FILE_BYTES}. ` +
      (sandbox.escalationModes.length > 0
        ? 'If the sandbox denies a write, retry this exact call once with `sandbox_permissions` (the narrowest wider mode) and `justification`; approval applies to this one call. '
        : '') +
      'For renaming a code identifier, prefer an LSP rename tool when one is configured — it respects scope and leaves strings and comments alone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        glob: {
          type: 'string',
          description:
            'Path glob selecting files, relative to the search root. Supports `**`, `*`, `?`, `[...]`, and `{a,b}`; a pattern without `/` matches the basename at any depth (e.g. "src/**/*.ts", "*.md", "**/*.{js,ts}").',
        },
        pattern: {
          type: 'string',
          description: 'Regular expression to find, or the exact string to find when `literal` is true.',
        },
        replacement: {
          type: 'string',
          description: 'Replacement text. In regex mode `$1`, `$<name>`, `$&`, and `$$` behave as in JavaScript String.replace.',
        },
        path: {
          type: 'string',
          description: 'Directory to search in; defaults to the session working directory. A relative path resolves against it.',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns (same syntax as `glob`) whose matches are skipped, e.g. ["**/*.test.ts", "vendor/**"].',
        },
        literal: {
          type: 'boolean',
          description: 'Treat `pattern` as fixed text instead of a regular expression. Defaults to false.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Report matching files and counts without writing anything. Defaults to false.',
        },
        max_files: {
          type: 'integer',
          description: `Stop after this many matching files (1–${HARD_MAX_FILES}). Defaults to ${DEFAULT_MAX_FILES}; the result sets truncated when the glob matched more.`,
        },
        max_file_bytes: {
          type: 'integer',
          description: `Skip files larger than this many bytes. Defaults to ${DEFAULT_MAX_FILE_BYTES}.`,
        },
        ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
      },
      required: ['glob', 'pattern', 'replacement'],
    },
    timeoutMs: 120_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                replacements: { type: 'integer' },
                status: { type: 'string', enum: ['changed', 'would-change', 'skipped', 'error'] },
                message: { type: 'string' },
              },
              required: ['path', 'replacements', 'status'],
            },
          },
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                before: { type: 'string' },
                after: { type: 'string' },
              },
              required: ['path', 'before', 'after'],
            },
          },
          files_considered: { type: 'integer' },
          files_changed: { type: 'integer' },
          replacements: { type: 'integer' },
          skipped: { type: 'integer' },
          truncated: { type: 'boolean' },
          diffs_truncated: { type: 'boolean' },
          dry_run: { type: 'boolean' },
        },
        required: [
          'files',
          'diffs',
          'files_considered',
          'files_changed',
          'replacements',
          'skipped',
          'truncated',
          'diffs_truncated',
          'dry_run',
        ],
      },
      render: (args, value) => [
        { type: 'text', text: renderResult(args, value) },
      ],
      presentationMeta: (args, value) => ({
        glob: typeof args?.glob === 'string' ? args.glob : '',
        pattern: typeof args?.pattern === 'string' ? args.pattern : '',
        literal: args?.literal === true,
        dry_run: value.dry_run,
        diffs: value.diffs.map((diff) => ({ path: diff.path, oldText: diff.before, newText: diff.after })),
        ...(value.diffs_truncated ? { diffs_truncated: true } : {}),
      }),
    },
    async execute(args, exec) {
      const input = parseInput(args)
      const matcher = compileMatcher(input.pattern, input.literal)
      const includes = compileGlob(input.glob)
      const excludes = input.exclude.map(compileGlob)
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const root = await ctx.fs.resolve(input.path ?? '.', { cwd, signal: exec.signal })
      const rootInfo = await ctx.fs.stat(root, exec.signal)
      if (rootInfo === undefined) throw new Error(`search root "${root.displayPath}" does not exist`)
      if (rootInfo.type !== 'directory') throw new Error(`search root "${root.displayPath}" is not a directory`)
      // The per-session policy carries the Session workspace root; omitting it
      // falls back to the deployment root and denies writes inside the Session.
      // A requested escalation is approved here, before the first write.
      const sandboxPolicy = await sandbox.resolvePolicy('glob_replace', args, exec)

      const candidates = []
      let truncated = false
      for await (const entry of walkFiles(ctx, root, exec.signal)) {
        const path = toPosix(relative(root.targetKey, entry.target.targetKey))
        if (path === '' || path.startsWith('../') || isAbsolute(path)) continue
        if (!includes(path)) continue
        if (excludes.some((matches) => matches(path))) continue
        if (candidates.length >= input.maxFiles) {
          truncated = true
          break
        }
        candidates.push({ path, target: entry.target })
      }

      const files = []
      const diffs = []
      let filesChanged = 0
      let replacements = 0
      let skipped = 0
      for (const candidate of candidates) {
        if (exec.signal?.aborted) throw new Error('glob_replace aborted')
        let stat
        try {
          stat = await ctx.fs.stat(candidate.target, exec.signal)
        } catch (error) {
          files.push({ path: candidate.path, replacements: 0, status: 'error', message: messageOf(error) })
          continue
        }
        if (stat === undefined || stat.type !== 'file') {
          files.push({ path: candidate.path, replacements: 0, status: 'skipped', message: 'not a regular file' })
          skipped += 1
          continue
        }
        if (stat.size > input.maxFileBytes) {
          files.push({
            path: candidate.path,
            replacements: 0,
            status: 'skipped',
            message: `larger than max_file_bytes (${stat.size} > ${input.maxFileBytes})`,
          })
          skipped += 1
          continue
        }
        let before
        try {
          before = await ctx.fs.readText(candidate.target, exec.signal)
        } catch (error) {
          files.push({ path: candidate.path, replacements: 0, status: 'skipped', message: messageOf(error) })
          skipped += 1
          continue
        }
        let count
        try {
          count = countMatches(before, matcher)
        } catch (error) {
          throw new Error(`${candidate.path}: ${messageOf(error)}`)
        }
        if (count === 0) continue
        if (count > MAX_REPLACEMENTS_PER_FILE) {
          files.push({
            path: candidate.path,
            replacements: count,
            status: 'skipped',
            message: `more than ${MAX_REPLACEMENTS_PER_FILE} matches in one file; narrow the pattern`,
          })
          skipped += 1
          continue
        }
        const after = replaceAll(before, matcher, input.replacement)
        if (after === before) continue
        if (!input.dryRun) {
          try {
            ctx.emit('fs/observed', candidate.target, { kind: 'present', version: stat.version }, exec)
            const intent = await ctx.waterfall('fs/write-intent', candidate.target, exec, () => undefined)
            await ctx.fs.writeText(candidate.target, after, intent, exec.signal, sandboxPolicy)
          } catch (error) {
            if (error !== null && typeof error === 'object' && error.code === 'FS_SANDBOX_DENIED') {
              throw new Error(
                `${sandboxDenialMarker(sandboxPolicy?.mode ?? ctx.fs.sandboxMode)}\n${escalationHintMarker('operation')}`,
              )
            }
            files.push({ path: candidate.path, replacements: count, status: 'error', message: messageOf(error) })
            continue
          }
        }
        filesChanged += 1
        replacements += count
        files.push({
          path: candidate.path,
          replacements: count,
          status: input.dryRun ? 'would-change' : 'changed',
        })
        diffs.push({ path: candidate.path, before, after })
      }

      const bounded = boundDiffs(diffs)
      return {
        files,
        diffs: bounded.kept,
        files_considered: candidates.length,
        files_changed: filesChanged,
        replacements,
        skipped,
        truncated,
        diffs_truncated: bounded.truncated,
        dry_run: input.dryRun,
      }
    },
  }
  ctx.tools.register(tool)
}

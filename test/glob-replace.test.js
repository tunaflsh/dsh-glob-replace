import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { after, before, test } from 'node:test'
import {
  apply,
  compileGlob,
  compileMatcher,
  countMatches,
  diffHunks,
  expandBraces,
  replaceAll,
} from '../index.js'

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'glob-replace-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

function fakeContext(options = {}) {
  const tools = []
  const writes = []
  const ctx = {
    tools: { register: (tool) => { tools.push(tool) } },
    workingDirectory: { ensure: async () => process.cwd() },
    emit: () => {},
    waterfall: async (_name, _target, _exec, next) => next(),
    get: (name) => {
      if (name === 'sandboxPolicy') return { resolve: () => options.policy }
      if (name === 'approval') return options.approval
      return undefined
    },
    fs: {
      async resolve(path, options) {
        const base = options?.cwd ?? process.cwd()
        const absolute = isAbsolute(path) ? path : resolvePath(base, path)
        return { targetKey: absolute, displayPath: path }
      },
      async stat(target) {
        try {
          const info = await stat(target.targetKey)
          return {
            version: `${info.size}:${info.mtimeMs}`,
            type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
            size: info.size,
          }
        } catch {
          return undefined
        }
      },
      async readText(target) {
        return readFile(target.targetKey, 'utf8')
      },
      async writeText(target, content, intent, signal, policy) {
        if (options.denyWrites === true) {
          const error = new Error('file access denied under workspace-write mode')
          error.code = 'FS_SANDBOX_DENIED'
          throw error
        }
        writes.push({ target, policy })
        await writeFile(target.targetKey, content, 'utf8')
        return { operation: 'update' }
      },
      async listDir(target) {
        const { readdir } = await import('node:fs/promises')
        const entries = await readdir(target.targetKey, { withFileTypes: true })
        const result = []
        for (const entry of entries) {
          const absolute = join(target.targetKey, entry.name)
          const info = await stat(absolute)
          result.push({
            name: entry.name,
            type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
            target: { targetKey: absolute, displayPath: entry.name },
            version: `${info.size}:${info.mtimeMs}`,
            size: info.size,
          })
        }
        return result
      },
    },
  }
  if (options.sandboxMode !== undefined) ctx.fs.sandboxMode = options.sandboxMode
  apply(ctx)
  assert.equal(tools.length, 1)
  return { ctx, tool: tools[0], writes }
}

async function run(args, ctx, execOverrides = {}) {
  const { tool } = ctx ?? fakeContext()
  return tool.execute(args, { agent: undefined, signal: new AbortController().signal, ...execOverrides })
}

/** A minimal agent the approval seam can route through. */
const AGENT = { session: {} }

async function seed(structure) {
  for (const [path, content] of Object.entries(structure)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
}

test('expandBraces expands alternatives', () => {
  assert.deepEqual(expandBraces('a.{js,ts}'), ['a.js', 'a.ts'])
  assert.deepEqual(expandBraces('{a,b}/x.{c,d}').sort(), ['a/x.c', 'a/x.d', 'b/x.c', 'b/x.d'])
})

test('compileGlob matches paths and basenames', () => {
  assert.ok(compileGlob('src/**/*.ts')('src/a.ts'))
  assert.ok(compileGlob('src/**/*.ts')('src/deep/a.ts'))
  assert.ok(!compileGlob('src/**/*.ts')('src/a.js'))
  assert.ok(compileGlob('*.md')('docs/readme.md'))
  assert.ok(!compileGlob('*.md')('docs/readme.md.bak'))
  assert.ok(compileGlob('**/*.{js,ts}')('x/y.ts'))
})

test('literal matcher counts and replaces without regex semantics', () => {
  const matcher = compileMatcher('a.b', true)
  assert.equal(countMatches('a.b axb a.b', matcher), 2)
  assert.equal(replaceAll('a.b axb a.b', matcher, '$1'), '$1 axb $1')
})

test('regex matcher supports capture references', () => {
  const matcher = compileMatcher('foo\\((\\d+)\\)', false)
  assert.equal(countMatches('foo(1) foo(2)', matcher), 2)
  assert.equal(replaceAll('foo(1) foo(2)', matcher, 'bar($1)'), 'bar(1) bar(2)')
  assert.throws(() => countMatches('x', compileMatcher('x*', false)))
})

test('diffHunks reports only changed regions', () => {
  const hunks = diffHunks('a\nb\nc\n', 'a\nB\nc\n')
  assert.equal(hunks.length, 1)
  assert.deepEqual(hunks[0].lines.slice(0, 4), [' a', '-b', '+B', ' c'])
})

test('glob_replace rewrites matching files only', async () => {
  await seed({
    'src/a.ts': 'const foo = 1\n',
    'src/deep/b.ts': 'foo()\n',
    'src/c.js': 'foo\n',
    'node_modules/x.ts': 'foo\n',
    'README.md': 'foo\n',
  })
  const result = await run({ glob: '**/*.ts', pattern: 'foo', replacement: 'bar', literal: true, path: root })
  assert.equal(result.files_changed, 2)
  assert.equal(result.replacements, 2)
  assert.equal(await readFile(join(root, 'src/a.ts'), 'utf8'), 'const bar = 1\n')
  assert.equal(await readFile(join(root, 'src/deep/b.ts'), 'utf8'), 'bar()\n')
  assert.equal(await readFile(join(root, 'node_modules/x.ts'), 'utf8'), 'foo\n')
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'foo\n')
})

test('regex mode rewrites with capture references', async () => {
  await seed({ 'agent.ts': 'log("a")\nlog("b")\n' })
  const result = await run({
    glob: '**/*.ts',
    pattern: 'log\\("([^"]+)"\\)',
    replacement: 'logger.info("$1")',
    path: root,
  })
  assert.equal(result.files_changed, 1)
  assert.equal(result.replacements, 2)
  assert.equal(await readFile(join(root, 'agent.ts'), 'utf8'), 'logger.info("a")\nlogger.info("b")\n')
})

test('dry_run reports without writing', async () => {
  await seed({ 'dry.ts': 'foo foo\n' })
  const result = await run({ glob: 'dry.ts', pattern: 'foo', replacement: 'bar', literal: true, dry_run: true, path: root })
  assert.equal(result.files_changed, 1)
  assert.equal(result.files[0].status, 'would-change')
  assert.equal(await readFile(join(root, 'dry.ts'), 'utf8'), 'foo foo\n')
})

test('exclude skips matches and max_files truncates', async () => {
  await seed({ 'many/a.ts': 'foo\n', 'many/b.ts': 'foo\n', 'many/c.ts': 'foo\n' })
  const excluded = await run({
    glob: 'many/*.ts',
    pattern: 'foo',
    replacement: 'bar',
    literal: true,
    exclude: ['many/b.ts'],
    path: root,
  })
  assert.equal(excluded.files_changed, 2)

  await seed({ 'limit/1.ts': 'alpha\n', 'limit/2.ts': 'alpha\n', 'limit/3.ts': 'alpha\n' })
  const limited = await run({
    glob: 'limit/*.ts',
    pattern: 'alpha',
    replacement: 'beta',
    literal: true,
    max_files: 1,
    path: root,
  })
  assert.equal(limited.truncated, true)
  assert.equal(limited.files_changed, 1)
})

test('presentation meta marks dry runs and carries native diff shape', () => {
  const { tool } = fakeContext()
  const meta = tool.output.presentationMeta(
    { glob: '*.ts', pattern: 'a', replacement: 'b' },
    {
      files: [],
      diffs: [{ path: 'a.ts', before: 'a', after: 'b' }],
      files_considered: 1,
      files_changed: 0,
      replacements: 1,
      skipped: 0,
      truncated: false,
      diffs_truncated: false,
      dry_run: true,
    }
  )
  assert.equal(meta.dry_run, true)
  assert.deepEqual(meta.diffs, [{ path: 'a.ts', oldText: 'a', newText: 'b' }])
})

test('passes the per-session sandbox policy to every write', async () => {
  await seed({ 'sandboxed/x.ts': 'foo\n' })
  const policy = { mode: 'workspace-write', workspaceRoots: [root] }
  const ctx = fakeContext({ sandboxMode: 'workspace-write', policy })
  const result = await run({ glob: 'sandboxed/x.ts', pattern: 'foo', replacement: 'bar', literal: true, path: root }, ctx)
  assert.equal(result.files_changed, 1)
  assert.deepEqual(ctx.writes.at(-1).policy, policy)
})

test('advertises escalation fields only on a confining backend', () => {
  const plain = fakeContext()
  assert.equal(plain.tool.parameters.properties.sandbox_permissions, undefined)
  assert.equal(plain.tool.parameters.properties.justification, undefined)

  const confined = fakeContext({ sandboxMode: 'workspace-write', policy: { mode: 'workspace-write' } })
  assert.deepEqual(confined.tool.parameters.properties.sandbox_permissions.enum, ['workspace-write', 'danger-full-access'])
  assert.equal(typeof confined.tool.parameters.properties.justification.description, 'string')
})

test('a wider mode asks approval once and stamps the retry policy', async () => {
  await seed({ 'escalate/x.ts': 'foo\n' })
  const requests = []
  const approval = {
    request: async (request) => {
      requests.push(request)
      return 'allowed-once'
    },
  }
  const policy = { mode: 'read-only', workspaceRoot: root }
  const ctx = fakeContext({ sandboxMode: 'read-only', policy, approval })
  const result = await run(
    {
      glob: 'escalate/x.ts',
      pattern: 'foo',
      replacement: 'bar',
      literal: true,
      path: root,
      sandbox_permissions: 'workspace-write',
      justification: 'the fixture is read-only in this session',
    },
    ctx,
    { agent: AGENT, callId: 'call-1' }
  )
  assert.equal(result.files_changed, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'glob_replace')
  assert.equal(requests[0].displayReason.en, 'Allow this operation with workspace-write permissions: the fixture is read-only in this session')
  assert.equal(ctx.writes.at(-1).policy.mode, 'workspace-write')
})

test('repeating the standing mode needs no approval', async () => {
  await seed({ 'repeat/x.ts': 'foo\n' })
  let asked = 0
  const approval = { request: async () => { asked += 1; return 'allowed-once' } }
  const ctx = fakeContext({ sandboxMode: 'workspace-write', policy: { mode: 'workspace-write', workspaceRoot: root }, approval })
  const result = await run(
    { glob: 'repeat/x.ts', pattern: 'foo', replacement: 'bar', literal: true, path: root, sandbox_permissions: 'workspace-write' },
    ctx
  )
  assert.equal(result.files_changed, 1)
  assert.equal(asked, 0)
})

test('a malformed escalation pair fails before any write', async () => {
  await seed({ 'pair/x.ts': 'foo\n' })
  const ctx = fakeContext({ sandboxMode: 'workspace-write', policy: { mode: 'workspace-write' } })
  await assert.rejects(
    run({ glob: 'pair/x.ts', pattern: 'foo', replacement: 'bar', literal: true, path: root, sandbox_permissions: 'danger-full-access' }, ctx),
    /requires a justification/
  )
  assert.equal(ctx.writes.length, 0)
})

test('a rejected escalation stops the call', async () => {
  await seed({ 'reject/x.ts': 'foo\n' })
  const approval = { request: async () => 'rejected' }
  const ctx = fakeContext({ sandboxMode: 'read-only', policy: { mode: 'read-only', workspaceRoot: root }, approval })
  await assert.rejects(
    run(
      {
        glob: 'reject/x.ts',
        pattern: 'foo',
        replacement: 'bar',
        literal: true,
        path: root,
        sandbox_permissions: 'workspace-write',
        justification: 'retry wider',
      },
      ctx,
      { agent: AGENT, callId: 'call-2' }
    ),
    /user rejected/
  )
  assert.equal(ctx.writes.length, 0)
})

test('a sandbox denial maps to the shared marker and escalation hint', async () => {
  await seed({ 'denied/x.ts': 'foo\n' })
  const ctx = fakeContext({
    sandboxMode: 'workspace-write',
    policy: { mode: 'workspace-write', workspaceRoot: root },
    denyWrites: true,
  })
  await assert.rejects(
    run({ glob: 'denied/x.ts', pattern: 'foo', replacement: 'bar', literal: true, path: root }, ctx),
    (error) =>
      error.message.includes('[sandbox: file access denied under workspace-write mode]') &&
      error.message.includes('escalation available')
  )
})

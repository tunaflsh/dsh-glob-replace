import { strict as assert } from 'node:assert'
import { test } from 'node:test'

/** Minimal stand-ins for the browser module table. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
}
function DisclosureRow() {}
function DiffBlock() {}
function IconEditOutlineRegular() {}
const primitives = {
  DisclosureRow,
  DiffBlock,
  IconEditOutlineRegular,
  diffTotals: () => ({ added: 2, removed: 1 }),
}
function fakeRequire() {
  return (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${specifier}`)
  }
}

test('client half registers a glob_replace DiffBlock toolview', async () => {
  let registration
  globalThis.window = {
    __ModuleLoader__: {
      load: (record) => {
        registration = record
      },
    },
  }
  await import('../client.js?test=1')
  assert.equal(registration.id, 'dsh-glob-replace')

  const exports = registration.factory(fakeRequire())
  assert.deepEqual(exports.inject, ['slots'])

  const registered = []
  const ctx = {
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => registered.push({ options, component }),
    },
  }
  exports.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.key, 'glob_replace')
  assert.equal(registered[0].options.name, 'tool.call.toolview')

  const block = {
    kind: 'tool',
    meta: { dry_run: true, diffs: [{ path: 'a.ts', oldText: 'foo\n', newText: 'bar\n' }, { path: 42 }] },
    isError: false,
  }
  const tree = registered[0].component({
    block,
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    t: (key) => key,
  })
  assert.equal(tree.type, DisclosureRow)
  assert.equal(tree.props.title, 'Glob replace')
  const diff = tree.children[0]
  assert.equal(diff.type, DiffBlock)
  assert.deepEqual(diff.props.diffs, [{ path: 'a.ts', oldText: 'foo\n', newText: 'bar\n' }])
  assert.equal(diff.props.labels.copy, 'copy')
  const collapsed = tree.props.collapsedContent
  assert.deepEqual(collapsed[0].props.style, {
    width: 2,
    height: 2,
    borderRadius: 1,
    background: 'var(--dsw-alias-label-caption)',
    margin: '0 8px',
    flex: 'none',
    display: 'inline-block',
  })
  assert.equal(collapsed[1].children[0], 'dry run · 1 file · +2 −1')
})

test('client half renders no diff for a running call', async () => {
  globalThis.window = { __ModuleLoader__: { load: (record) => { globalThis.__record = record } } }
  await import('../client.js?test=2')
  const exports = globalThis.__record.factory(fakeRequire())
  const registered = []
  exports.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => registered.push({ options, component }),
    },
  })
  const tree = registered[0].component({
    block: { phase: 'start' },
    useDisclosure: () => ({ expanded: false, toggle: () => {} }),
    t: (key) => key,
  })
  assert.equal(tree.type, DisclosureRow)
  assert.equal(tree.props.expandable, false)
  assert.equal(tree.props.collapsedContent[1].children[0], 'running…')
  assert.equal(tree.children[0], null)
})

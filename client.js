// dsh-glob-replace, browser half (hand-written in DSH's client module
// format, so no build step is needed).
//
// Registers a `tool.call.toolview` for `glob_replace` that renders the
// exported DiffBlock primitive — the same component the built-in write/edit
// rows use — from the `diffs` metadata the host tool attaches. The row chrome
// comes from the exported DisclosureRow primitive, so it expands and collapses
// like the native rows.
window.__ModuleLoader__.load({
  id: 'dsh-glob-replace',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var DisclosureRow = primitives.DisclosureRow
    var DiffBlock = primitives.DiffBlock
    var diffTotals = primitives.diffTotals
    var IconEditOutlineRegular = primitives.IconEditOutlineRegular

    /** Fallback chrome labels for a locale seat that did not resolve. */
    var FALLBACK_LABELS = {
      codeLabel: 'diff',
      wrapLabel: 'Wrap',
      unwrapLabel: 'Unwrap',
      copy: 'Copy',
      copied: 'Copied',
      collapseAria: 'Collapse diff',
      expandAria: (count) => 'Show ' + count + ' hidden lines',
      collapse: 'Collapse',
      expand: (count) => 'Show ' + count + ' more lines'
    }

    /**
     * Build the same chrome labels the built-in diff card uses, from the
     * conversation dictionary when the locale seat is present.
     */
    function labelsFor(t) {
      if (typeof t !== 'function') return FALLBACK_LABELS
      try {
        return {
          codeLabel: t('codeBlock.title'),
          wrapLabel: t('codeBlock.wrap'),
          unwrapLabel: t('codeBlock.unwrap'),
          copy: t('copy'),
          copied: t('copied'),
          collapseAria: t('diff.collapseAria'),
          expandAria: (count) => t('diff.expandAria', { count }),
          collapse: t('collapse'),
          expand: (count) => t('diff.expandRest', { count })
        }
      } catch (error) {
        return FALLBACK_LABELS
      }
    }

    /** Narrow persisted meta.diffs; malformed entries are dropped, not rendered. */
    function narrowDiffs(meta) {
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
      var diffs = meta.diffs
      if (!Array.isArray(diffs)) return []
      var out = []
      for (var index = 0; index < diffs.length; index += 1) {
        var diff = diffs[index]
        if (typeof diff !== 'object' || diff === null) continue
        var path = diff.path
        var oldText = diff.oldText
        var newText = diff.newText
        if (typeof path !== 'string') continue
        if (oldText !== null && typeof oldText !== 'string') continue
        if (typeof newText !== 'string') continue
        out.push({ path: path, oldText: oldText, newText: newText })
      }
      return out
    }

    /** Whether the block is a settled tool result rather than a call head. */
    function isSettled(block) {
      return typeof block === 'object' && block !== null && 'kind' in block
    }

    /** The native row's separator dot, inlined because its CSS class is module-private. */
    var SEPARATOR_STYLE = {
      width: 2,
      height: 2,
      borderRadius: 1,
      background: 'var(--dsw-alias-label-caption)',
      margin: '0 8px',
      flex: 'none',
      display: 'inline-block'
    }

    /** Title-adjacent summary with the same separator the built-in rows use. */
    function collapsedContentFor(block, diffs) {
      return [
        h('span', { 'data-shimmer-decoration': true, 'aria-hidden': true, style: SEPARATOR_STYLE }),
        h('span', null, summaryFor(block, diffs))
      ]
    }

    /** One-line collapsed summary: file count and line totals, or the running cue. */
    function summaryFor(block, diffs) {
      if (!isSettled(block)) return 'running…'
      if (block.isError) return 'failed'
      if (diffs.length === 0) return 'no changes'
      var totals = diffTotals(diffs)
      var files = diffs.length === 1 ? '1 file' : diffs.length + ' files'
      var prefix = block.meta && block.meta.dry_run === true ? 'dry run · ' : ''
      return prefix + files + ' · +' + totals.added + ' −' + totals.removed
    }

    /**
     * Diff card for a glob_replace call: DisclosureRow chrome plus the shared
     * DiffBlock, driven by the tool's `meta.diffs`.
     */
    function GlobReplaceRow(props) {
      var block = props.block
      var useDisclosure = props.useDisclosure
      var disclosure = useDisclosure()
      var diffs = isSettled(block) ? narrowDiffs(block.meta) : []
      var labels = labelsFor(props.t)
      return h(
        DisclosureRow,
        {
          icon: IconEditOutlineRegular ? h(IconEditOutlineRegular, { size: 14 }) : null,
          title: 'Glob replace',
          open: disclosure.expanded,
          expandable: diffs.length > 0,
          onToggle: disclosure.toggle,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          collapsedContent: collapsedContentFor(block, diffs),
        },
        diffs.length > 0
          ? h(DiffBlock, {
              diffs: diffs,
              labels: labels,
              maxLines: 12,
            })
          : null
      )
    }

    var inject = ['slots']

    /**
     * Claim the `glob_replace` tool row. A keyed registration replaces the
     * generic row for that tool name; every other tool keeps its own view.
     */
    function apply(ctx) {
      // A host build without the shared primitives keeps the generic tool row
      // instead of breaking the client boot with an undefined component.
      if (!DisclosureRow || typeof DiffBlock !== 'function' || typeof diffTotals !== 'function') return
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: 'glob_replace',
            locale: 'conversation',
          },
          GlobReplaceRow
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

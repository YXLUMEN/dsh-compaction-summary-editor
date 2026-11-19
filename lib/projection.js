/**
 * Pure projection unit: the compaction checkpoints that are still on the
 * session surface, each with the text the model currently reads.
 *
 * The framework drives `apply` over every committed session event; this module
 * only computes. State is plain JSON so the projection cache can checkpoint and
 * replay it.
 *
 * @module dsh-compaction-summary-editor/lib/projection
 */

/** Projection key registered on `ctx.sessionProjections`. */
export const PROJECTION_KEY = 'compactionSummaryEdit'

/** Tags `dsh-compaction-basic` wraps around a summary inside the checkpoint body. */
const OPEN_TAG = '<compacted-summary>'
const CLOSE_TAG = '</compacted-summary>'

/** Bound on retained checkpoints; a session normally keeps one. */
const MAX_ENTRIES = 8

/** Accept every value: the registry only calls `parse` before handing state on. */
const permissiveSchema = Object.freeze({parse: value => value})

/** Read the text of one block array, ignoring non-text blocks. */
function blocksToText(blocks) {
    if (!Array.isArray(blocks)) return ''
    let text = ''
    for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    }
    return text
}

/** Trim only the whitespace this project owns at the checkpoint edges. */
function trimEdges(text) {
    return text.replace(/^[\s]+/u, '').replace(/[\s]+$/u, '')
}

/**
 * Split a checkpoint body into its framing and its summary text.
 * @param {unknown} content - checkpoint message content blocks.
 * @returns {{ text: string | undefined, prefix: string, suffix: string, framed: boolean }}
 *   the summary text, whether the body carries a recognizable summary envelope,
 *   and the framing around it.
 */
export function readCheckpointBody(content) {
    const raw = blocksToText(content)
    const open = raw.indexOf(OPEN_TAG)
    const close = raw.lastIndexOf(CLOSE_TAG)
    if (open !== -1 && close > open) {
        const textStart = open + OPEN_TAG.length
        return {
            text: trimEdges(raw.slice(textStart, close)),
            prefix: raw.slice(0, textStart),
            suffix: raw.slice(close),
            framed: true,
        }
    }
    // A backend this editor cannot frame: report the body read-only rather than
    // rewriting it with a different envelope. The summary event keeps the text.
    return {text: trimEdges(raw), prefix: '', suffix: '', framed: false}
}

/**
 * Rebuild one checkpoint body around edited summary text, preserving the
 * framing the backend that produced it used.
 * @param {{ prefix?: string, suffix?: string } | undefined} entry - recorded framing.
 * @param {string} text - the summary text to land.
 * @returns {Array<{ type: 'text', text: string }>} replacement content blocks.
 */
export function buildCheckpointBody(entry, text) {
    const prefix = typeof entry?.prefix === 'string' ? entry.prefix : ''
    const suffix = typeof entry?.suffix === 'string' ? entry.suffix : ''
    const summary = {type: 'text', text}
    if (prefix === '' && suffix === '') return [summary]
    return [prefix === '' ? null : {type: 'text', text: prefix}, summary,
        suffix === '' ? null : {type: 'text', text: suffix}].filter(block => block !== null)
}

/** Compare two summary texts the way the editor displays them. */
export function sameSummary(left, right) {
    return trimEdges(typeof left === 'string' ? left : '') === trimEdges(typeof right === 'string' ? right : '')
}

/** Find one entry by compaction identity. */
function entryOf(state, id) {
    return state.entries.find(entry => entry.id === id)
}

/** Replace or append one entry, keeping first-seen order. */
function withEntry(entries, entry) {
    const at = entries.findIndex(candidate => candidate.id === entry.id)
    if (at === -1) return [...entries, entry]
    const next = entries.slice()
    next[at] = entry
    return next
}

/** Bound retention without reordering the surviving entries. */
function capped(entries) {
    if (entries.length <= MAX_ENTRIES) return entries
    const keep = new Set(entries
        .map(entry => entry)
        .sort((left, right) => (right.checkpointSeq ?? -1) - (left.checkpointSeq ?? -1))
        .slice(0, MAX_ENTRIES))
    return entries.filter(entry => keep.has(entry))
}

/** Whether this event rewrites the surface rather than appending to it. */
function isReplacement(event) {
    const op = event.surfaceOp
    return op !== undefined && op !== 'append' && typeof op === 'object'
}

/** Apply one `compaction/summary` event. */
function applySummary(state, event) {
    const data = event.data
    const id = data?.compactionId
    if (typeof id !== 'string' || id === '') return state
    const original = trimEdges(blocksToText(data.summary))
    const previous = entryOf(state, id)
    const summaryEventSeq = event.seq
    const itemCount = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null
    const tokenCount = Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0
        ? data.shadowedTokenCount
        : null
    if (previous !== undefined
        && previous.summaryEventSeq === summaryEventSeq
        && previous.original === original
        && previous.itemCount === itemCount
        && previous.tokenCount === tokenCount) {
        return state
    }
    const entry = {
        ...previous ?? {
            id,
            checkpointSeq: null,
            current: original,
            prefix: '',
            suffix: '',
            framed: false,
            sourceCommandId: undefined,
            time: event.time
        },
        id,
        summaryEventSeq,
        original,
        itemCount,
        tokenCount,
    }
    if (previous === undefined) delete entry.sourceCommandId
    return {entries: withEntry(state.entries, entry)}
}

/** Apply one replacement surface event: drop shadowed checkpoints, adopt a new one. */
function applyReplacement(state, event) {
    const shadowed = new Set()
    if (Array.isArray(event.sourceEventSeqs)) {
        for (const seq of event.sourceEventSeqs) shadowed.add(seq)
    }
    const op = event.surfaceOp
    if (typeof op?.startSeq === 'number' && typeof op?.endSeq === 'number') {
        const from = Math.min(op.startSeq, op.endSeq)
        const to = Math.max(op.startSeq, op.endSeq)
        for (const entry of state.entries) {
            if (typeof entry.checkpointSeq === 'number' && entry.checkpointSeq >= from && entry.checkpointSeq <= to) {
                shadowed.add(entry.checkpointSeq)
            }
        }
    }

    const kept = state.entries.filter(entry => !shadowed.has(entry.checkpointSeq))
    const data = event.data
    const source = data && typeof data === 'object' ? data.source : undefined
    let adopted = kept
    if (event.type === 'user/message' && source && source.kind === 'compact-checkpoint'
        && typeof source.compactionId === 'string') {
        const body = readCheckpointBody(data.content)
        if (body.text !== undefined) {
            const previous = entryOf(state, source.compactionId)
            adopted = withEntry(kept.filter(entry => entry.id !== source.compactionId), {
                ...previous ?? {id: source.compactionId},
                id: source.compactionId,
                checkpointSeq: event.seq,
                summaryEventSeq: previous?.summaryEventSeq ?? null,
                original: previous?.original ?? body.text,
                current: body.text,
                prefix: body.prefix,
                suffix: body.suffix,
                framed: body.framed,
                sourceCommandId: typeof source.sourceCommandId === 'string' ? source.sourceCommandId : previous?.sourceCommandId,
                itemCount: previous?.itemCount ?? null,
                tokenCount: previous?.tokenCount ?? null,
                time: event.time,
            })
        }
    }

    if (adopted.length === state.entries.length
        && adopted.every((entry, index) => entry === state.entries[index])) {
        return state
    }
    return {entries: capped(adopted)}
}

/** Cached client views, keyed by state reference, so an unchanged value keeps its identity. */
const viewCache = new WeakMap()

/** Build the whole client view for one state reference. */
function computeView(state) {
    const items = state.entries
        .filter(entry => typeof entry.checkpointSeq === 'number')
        .map(entry => ({
            id: entry.id,
            seq: entry.checkpointSeq,
            original: entry.original ?? '',
            current: entry.current ?? '',
            // The edited flag compares summary text only, and an unframed body has no
            // summary text of its own to compare, so it never claims a user edit.
            edited: entry.framed === true && !sameSummary(entry.current, entry.original),
            editable: entry.framed === true && typeof entry.current === 'string' && entry.current.trim() !== '',
            itemCount: entry.itemCount ?? null,
            tokenCount: entry.tokenCount ?? null,
            time: entry.time,
        }))
        .sort((left, right) => left.seq - right.seq)
    return {items}
}

/** Projection definition registered on `ctx.sessionProjections`. */
export const compactionSummaryProjection = {
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: permissiveSchema,
    /**
     * @param {unknown} _header - immutable session metadata.
     * @param {number} _inheritedEventCount - inherited prefix length.
     * @returns {{ entries: any[] }} empty state.
     */
    init: (_header, _inheritedEventCount) => ({entries: []}),
    /**
     * @param {{ entries: any[] }} state - state covering every prior event.
     * @param {any} event - next committed session event.
     * @returns {{ entries: any[] }} next state, or the same reference when uninterested.
     */
    apply: (state, event) => {
        if (event === null || typeof event !== 'object') return state
        if (event.type === 'compaction/summary') return applySummary(state, event)
        if (!isReplacement(event)) return state
        return applyReplacement(state, event)
    },
    wire: {
        summary: false,
        viewSchema: permissiveSchema,
        /**
         * Current checkpoints, newest last.
         * @param {{ entries: any[] }} state - current state.
         * @returns {{ items: any[] }} client view.
         */
        view: state => {
            const cached = viewCache.get(state)
            if (cached !== undefined) return cached
            const view = computeView(state)
            viewCache.set(state, view)
            return view
        },
    },
}

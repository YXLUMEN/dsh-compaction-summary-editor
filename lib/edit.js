/**
 * One user edit of a landed compaction summary.
 *
 * The compaction checkpoint is an ordinary surface `user/message` carrying a
 * `compact-checkpoint` source. Editing it appends a replacement over exactly
 * that node: the same source keeps the transaction identity (and the manual
 * command correlation), and the recorded framing around the summary is reused
 * so the model sees the envelope its backend produced.
 *
 * Requests name the compaction by identity, never by log position: one edit
 * moves the checkpoint to a new seq, and a second action must still find it.
 *
 * @module dsh-compaction-summary-editor/lib/edit
 */

import {buildCheckpointBody} from './projection.js'

/** Longest summary the editor accepts, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 200_000

/** Expected, user-visible failure of one edit. */
export class EditFailure extends Error {
    /**
     * @param {'invalid' | 'stale' | 'busy' | 'unframed' | 'rejected' | 'persistence'} code - failure class.
     * @param {string} message - already-localized user text.
     */
    constructor(code, message) {
        super(message)
        this.name = 'EditFailure'
        this.code = code
    }
}

/** Localized command-result and failure text. */
const MESSAGES = {
    zh: {
        saved: length => `已更新压缩摘要：模型之后看到的就是这段内容（${length} 字）。`,
        restored: '已恢复为压缩生成的原始摘要。',
        unchanged: '压缩摘要没有变化。',
        stale: '这条压缩摘要已不在当前会话中（会话历史在那之后又变了），请重新打开编辑器再试。',
        busy: '智能体正在运行，改写历史要等这一轮结束后才能保存。',
        unframed: '这段压缩摘要没有可识别的正文边界（不是 dsh-compaction-basic 写出的检查点），暂不支持编辑。',
        rejected: '会话拒绝这次改写：会话历史在那之后又变了。请重新打开编辑器再试。',
        persistence: '摘要已改写，但会话未能确认写入磁盘。请稍后重试保存（再次保存不会重复改写）。',
        badPayload: '这个命令由「上下文压缩摘要」插件调用，参数必须是一段 JSON。',
        missingId: '请求没有指明要改写哪一条压缩摘要。',
        missingText: '请求里没有摘要文本。',
        emptyText: '摘要内容不能为空。',
        tooLong: `摘要内容超过 ${MAX_TEXT_LENGTH} 个字符。`,
    },
    en: {
        saved: length => `Summary updated — the model now reads this text (${length} characters).`,
        restored: 'Restored the summary the model originally produced.',
        unchanged: 'The summary did not change.',
        stale: 'That compaction summary is no longer in this session (the history changed after it landed). Reopen the editor and try again.',
        busy: 'The agent is running, so its history can only be rewritten once this turn finishes.',
        unframed: 'This compaction summary has no recognizable body boundary (it was not produced by dsh-compaction-basic), so it cannot be edited here.',
        rejected: 'The session refused the rewrite: its history changed after that summary landed. Reopen the editor and try again.',
        persistence: 'The summary was rewritten, but the session could not confirm the write to disk. Save again later; repeating this safe edit does not rewrite it twice.',
        badPayload: 'This command is driven by the compaction summary editor; its arguments must be JSON.',
        missingId: 'The request does not name which compaction summary to rewrite.',
        missingText: 'The request carries no summary text.',
        emptyText: 'The summary text cannot be empty.',
        tooLong: `The summary text is longer than ${MAX_TEXT_LENGTH} characters.`,
    },
}

/**
 * Parse the command line payload the editor sends.
 * @param {string} rawInput - everything after the command name.
 * @param {'zh' | 'en'} lang - language for failure text.
 * @returns {{ id: string, text: string | null, restore: boolean, lang: 'zh' | 'en' }} request.
 * @throws {EditFailure} when the payload is not this command's JSON request.
 */
export function parseEditRequest(rawInput, lang) {
    const t = MESSAGES[lang === 'zh' ? 'zh' : 'en']
    let payload
    try {
        payload = JSON.parse(String(rawInput ?? '').trim())
    } catch {
        throw new EditFailure('invalid', t.badPayload)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new EditFailure('invalid', t.badPayload)
    }
    const id = payload.id
    if (typeof id !== 'string' || id === '') throw new EditFailure('invalid', t.missingId)
    const restore = payload.restore === true
    const text = typeof payload.text === 'string' ? payload.text : null
    if (!restore) {
        if (text === null) throw new EditFailure('invalid', t.missingText)
        if (text.trim() === '') throw new EditFailure('invalid', t.emptyText)
        if (text.length > MAX_TEXT_LENGTH) throw new EditFailure('invalid', t.tooLong)
    }
    return {id, text, restore, lang: lang === 'zh' ? 'zh' : 'en'}
}

/** Mint a message identity that survives the session's JSON snapshot. */
function newMessageId() {
    const webCrypto = globalThis.crypto
    if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID()
    return `cse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Apply one edit to the session surface.
 * @param {object} options - edit context.
 * @param {import('@deepseek-ai/dsh-agent/types').Agent} options.agent - agent owning the session.
 * @param {{ stateOf: (session: any) => { entries: any[] } }} options.handle - projection handle.
 * @param {{ id: string, text: string | null, restore: boolean, lang: 'zh' | 'en' }} options.request - parsed request.
 * @param {() => (((session: any) => Promise<unknown>) | undefined)} [options.flush] - durability checkpoint lookup.
 * @returns {Promise<{ kind: 'success', text: string }>} settled result.
 */
export async function performEdit({agent, handle, request, flush}) {
    const t = MESSAGES[request.lang]
    const session = agent.session

    /** Read the current checkpoint this request targets. */
    const targetOf = () => {
        const state = handle.stateOf(session)
        const entry = state.entries.find(candidate => candidate.id === request.id)
        if (entry === undefined || typeof entry.checkpointSeq !== 'number') {
            throw new EditFailure('stale', t.stale)
        }
        return entry
    }

    /** Durability barrier, resolved at call time so a late service still counts. */
    const settle = async () => {
        const writer = typeof flush === 'function' ? flush() : undefined
        if (typeof writer !== 'function') return
        try {
            await writer(session)
        } catch {
            throw new EditFailure('persistence', t.persistence)
        }
    }

    const first = targetOf()
    if (first.framed !== true) throw new EditFailure('unframed', t.unframed)
    const next = request.restore ? first.original : request.text
    if (typeof next !== 'string' || next.trim() === '') throw new EditFailure('invalid', t.emptyText)
    if (next.trim() === first.current.trim()) {
        // The wanted text is already on the surface; still honour a durability
        // retry after a previous attempt landed without confirming persistence.
        await settle()
        return {kind: 'success', text: t.unchanged}
    }
    // A running agent owns its surface until the turn settles.
    if (agent.status !== 'idle') throw new EditFailure('busy', t.busy)

    const text = next.trim()
    let landed = false
    try {
        await agent.runMaintenance(async () => {
            const entry = targetOf()
            if (entry.framed !== true) throw new EditFailure('unframed', t.unframed)
            if (text === entry.current.trim()) return
            session.append('user/message', {
                id: newMessageId(),
                role: 'user',
                content: buildCheckpointBody(entry, text),
                source: {
                    kind: 'compact-checkpoint',
                    compactionId: entry.id,
                    ...typeof entry.sourceCommandId === 'string' ? {sourceCommandId: entry.sourceCommandId} : {},
                },
            }, {
                surfaceOp: {op: 'replace', startSeq: entry.checkpointSeq, endSeq: entry.checkpointSeq},
                sourceEventSeqs: [entry.checkpointSeq],
            })
            landed = true
        })
    } catch (error) {
        if (error instanceof EditFailure) throw error
        if (!landed) {
            // A synchronous maintenance refusal means the agent was not available; a
            // surface rejection means the target moved between the read and the write.
            const message = String(error?.message ?? error)
            if (/surface replace|not found in surface|current surface/iu.test(message)) {
                throw new EditFailure('rejected', t.rejected)
            }
            throw new EditFailure('busy', t.busy)
        }
        throw new EditFailure('persistence', t.persistence)
    }

    if (landed) await settle()
    return {
        kind: 'success',
        text: request.restore ? t.restored : t.saved(text.length),
    }
}

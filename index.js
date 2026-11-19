/**
 * Host half of the compaction summary editor.
 *
 * DSH's context compaction replaces older history with one checkpoint message
 * holding a model-written summary. That text is model-visible history, so a user
 * who spots a wrong or missing fact should be able to correct it. This half
 * publishes the compaction checkpoints that are still on the session surface as
 * the `compactionSummaryEdit` session projection, and applies one edit per
 * invocation of the `compaction-summary-edit` command by appending a
 * replacement over exactly that checkpoint node.
 *
 * The command is the Client-callable entry point (`ctx.remote.commands.execute`
 * from the plugin's own UI, which leaves a small log-only command row in the
 * transcript). Nothing here is exposed to the model as a tool, because only the
 * user may rewrite model-visible history.
 *
 * @module dsh-compaction-summary-editor
 */

import { compactionSummaryProjection } from './lib/projection.js'
import { EditFailure, parseEditRequest, performEdit } from './lib/edit.js'

export const name = 'compaction-summary-editor'

/** Both registries must exist before this half can publish anything. */
export const inject = ['commands', 'sessionProjections']

/** Internal command the plugin's own UI dispatches. */
const COMMAND_NAME = 'compaction-summary-edit'

/** Read the payload's language before the payload itself parses. */
function languageOf(rawInput) {
  return /"lang"\s*:\s*"zh"/u.test(String(rawInput ?? '')) ? 'zh' : 'en'
}

/** Fold one failure into the command's user-visible result. */
function failureResult(error, lang) {
  if (error instanceof EditFailure) return { kind: 'error', text: error.message }
  const message = String(error?.message ?? error)
  return {
    kind: 'error',
    text: lang === 'zh'
      ? `改写压缩摘要失败：${message}`
      : `Editing the compaction summary failed: ${message}`,
  }
}

/**
 * Register the projection and the edit command.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  // A synchronous registration throw must not abort `apply` before the command
  // below exists, and the rejection must never stay unhandled: capture it.
  let registrationError
  const handleReady = Promise.resolve()
    .then(() => ctx.sessionProjections.register(compactionSummaryProjection))
    .catch(error => {
      registrationError = error
      ctx.logger?.warn?.('compaction-summary-editor: projection registration failed: %s', String(error?.message ?? error))
      return undefined
    })

  /**
   * Durability barrier lookup, resolved per edit so a late service still counts.
   * @returns {((session: any) => Promise<unknown>) | undefined} flush callback.
   */
  const flush = () => {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    return sessions !== undefined && typeof sessions.flush === 'function'
      ? session => sessions.flush(session)
      : undefined
  }

  /**
   * One edit request from the editor UI.
   * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation - command invocation.
   * @returns {Promise<import('@deepseek-ai/dsh-commands').CommandResult>} settled result.
   */
  async function handler(invocation) {
    const lang = languageOf(invocation.rawInput)
    let request
    try {
      request = parseEditRequest(invocation.rawInput, lang)
    } catch (error) {
      return failureResult(error, lang)
    }
    try {
      const handle = await handleReady
      if (handle === undefined) {
        return failureResult(registrationError ?? new Error('projection unavailable'), request.lang)
      }
      return await performEdit({ agent: invocation.agent, handle, request, flush })
    } catch (error) {
      return failureResult(error, request.lang)
    }
  }

  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-compaction-summary-editor',
    name: COMMAND_NAME,
    description: 'Rewrite the summary of a landed context compaction (dispatched by the compaction summary editor UI)',
    recordInput: false,
    handler,
  }), 'compaction-summary-editor command')
}

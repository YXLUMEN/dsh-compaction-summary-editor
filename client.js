/**
 * Client half of the compaction summary editor.
 *
 * Docks one compact bar above the composer for every compaction checkpoint that
 * is still on the session surface, showing whether the summary is the one the
 * model produced or one the user already edited. Expanding it shows the text the
 * model currently reads; the editor rewrites it through the plugin's Host
 * command (the mounted `remote.commands` namespace), which appends the surface
 * replacement. The bar renders nothing when the session has no live checkpoint.
 */

window.__ModuleLoader__.load({
    id: 'dsh-compaction-summary-editor',
    factory(require) {
        const React = require('react')
        const h = React.createElement
        const {useState} = React

        /** Slot locale namespace owned by this plugin. */
        const NS = 'compaction-summary-editor'
        /** Session projection key published by the Host half. */
        const PROJECTION_KEY = 'compactionSummaryEdit'
        /** Host command that applies one edit. */
        const COMMAND_NAME = 'compaction-summary-edit'

        const ZH = {
            'title': '上下文压缩摘要',
            'meta.items': '替换了 {count} 条历史',
            'meta.tokens': '约 {count} tokens',
            'meta.edited': '已编辑',
            'action.edit': '编辑',
            'action.save': '保存',
            'action.cancel': '取消',
            'action.restore': '恢复原始',
            'action.show': '展开压缩摘要',
            'action.hide': '收起压缩摘要',
            'hint.edit': '保存后，模型在后续请求中读到的压缩摘要就是这段内容。',
            'hint.original': '原始摘要仍保留在会话日志里，可以「恢复原始」还原。',
            'hint.marker': '对话记录里的压缩标记仍显示模型生成的原始摘要，并且会在保存后移动到编辑发生的位置。',
            'hint.running': '智能体运行中，结束后才能改写。',
            'label.textarea': '压缩摘要内容',
            'state.unframed': '这段摘要没有可识别的正文边界，只能查看。',
            'error.bridge': '无法连接 Host：remote.commands 命名空间不可用。',
            'error.unknown': '命令未注册，或调用被拒绝。',
            'error.save': '保存失败：{reason}',
        }
        const EN = {
            'title': 'Compaction summary',
            'meta.items': '{count} history items',
            'meta.tokens': '~{count} tokens',
            'meta.edited': 'edited',
            'action.edit': 'Edit',
            'action.save': 'Save',
            'action.cancel': 'Cancel',
            'action.restore': 'Restore original',
            'action.show': 'Show compaction summary',
            'action.hide': 'Hide compaction summary',
            'hint.edit': 'After saving, the summary the model reads in later requests is this text.',
            'hint.original': 'The original summary stays in the session log; Restore original brings it back.',
            'hint.marker': 'The transcript compaction marker still shows the model-produced summary, and it moves to the edit position after saving.',
            'hint.running': 'The agent is running; this summary can be rewritten when it finishes.',
            'label.textarea': 'Compaction summary text',
            'state.unframed': 'This summary has no recognizable body boundary, so it is view-only.',
            'error.bridge': 'Cannot reach the Host: the remote.commands namespace is unavailable.',
            'error.unknown': 'The command is not registered, or the call was refused.',
            'error.save': 'Save failed: {reason}',
        }

        const CSS = `
.cse-dock{display:flex;flex-direction:column;gap:8px;margin:0 auto;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));}
.cse-card{box-sizing:border-box;width:100%;overflow:hidden;border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);}
.cse-bar{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 6px 4px 12px;}
.cse-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary);}
.cse-label{flex:none;font-size:13px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);}
.cse-flag{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.cse-meta{flex:1 1 auto;min-width:0;overflow:hidden;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;}
.cse-actions{display:flex;flex:none;align-items:center;gap:2px;}
.cse-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}
.cse-icon:disabled{opacity:.4;cursor:default;}
.cse-textbtn{box-sizing:border-box;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:26px;cursor:pointer;}
.cse-textbtn:disabled{opacity:.4;cursor:default;}
.cse-chevron{display:inline-flex;transition:transform .12s ease;}
.cse-chevron[data-open=true]{transform:rotate(180deg);}
.cse-panel{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-top:0.5px solid var(--dsw-alias-border-l1);}
.cse-text{margin:0;max-height:40vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);}
.cse-textarea{box-sizing:border-box;width:100%;min-height:140px;max-height:40vh;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical;}
.cse-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.cse-hint{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.cse-foot{display:flex;align-items:center;gap:8px;}
.cse-buttons{display:flex;flex:none;align-items:center;gap:8px;}
.cse-notice{padding:0 12px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.cse-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary);}
.cse-notice[data-kind=ok]{color:var(--dsw-alias-state-success-primary);}
@media (hover:hover){
  .cse-icon:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}
  .cse-textbtn:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);}
}
`.trim()

        /** Build a translator over the built-in dictionaries (used when no locale seat arrives). */
        function makeFallback(lang) {
            const dict = lang === 'zh' ? ZH : EN
            return (key, params) => {
                const raw = dict[key] ?? key
                if (params === undefined) return raw
                return raw.replace(/\{(\w+)}/g, (match, name) => (
                    params[name] === undefined ? match : String(params[name])))
            }
        }

        /** Decorative glyph: a condensed text block. */
        function Glyph() {
            return h('svg', {width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'currentColor'},
                h('rect', {x: 2, y: 3, width: 12, height: 2, rx: 1}),
                h('rect', {x: 2, y: 7, width: 9, height: 2, rx: 1}),
                h('rect', {x: 2, y: 11, width: 6, height: 2, rx: 1}))
        }

        function Chevron() {
            return h('svg', {
                    width: 14,
                    height: 14,
                    viewBox: '0 0 16 16',
                    'aria-hidden': 'true',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.6,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round'
                },
                h('path', {d: 'M4 6.5 8 10.5 12 6.5'}))
        }

        /** Render one compaction checkpoint with its view/editor states. */
        function Row({item, sessionId, running, t, getCommands, getLang}) {
            const [mode, setMode] = useState('closed')
            const [draft, setDraft] = useState('')
            const [busy, setBusy] = useState(false)
            const [notice, setNotice] = useState(null)

            const editable = item.editable === true
            const locked = busy || (running === true)

            const open = nextMode => {
                if (nextMode === 'edit') setDraft(item.current)
                setNotice(null)
                setMode(nextMode)
            }

            const send = async payload => {
                setBusy(true)
                setNotice(null)
                try {
                    // The commands namespace is its own Cordis service (`remote.commands`),
                    // provided by the mounted Remote namespace; it carries the methods.
                    const commands = getCommands()
                    if (commands === undefined) {
                        setNotice({kind: 'error', text: t('error.bridge')})
                        return
                    }
                    // `id` is the identity the Host resolves; `seq` is the current surface
                    // anchor, sent for diagnostics and for a Host build that still targets
                    // by position (a running process keeps the module graph it booted).
                    const line = `/${COMMAND_NAME} ${JSON.stringify({
                        ...payload,
                        id: item.id,
                        seq: item.seq,
                        lang: getLang()
                    })}`
                    const answer = await commands.execute(sessionId, line, [])
                    const execution = answer !== null && typeof answer === 'object' && answer.ok === true
                        ? answer.value
                        : undefined
                    if (execution === undefined) {
                        const reason = answer !== null && typeof answer === 'object' && answer.error !== undefined
                            ? String(answer.error.message ?? answer.error.code ?? '')
                            : ''
                        setNotice({kind: 'error', text: reason === '' ? t('error.unknown') : t('error.save', {reason})})
                        return
                    }
                    const result = execution.result
                    if (result.kind === 'error') {
                        setNotice({kind: 'error', text: result.text})
                        return
                    }
                    setNotice({kind: 'ok', text: result.text ?? ''})
                    setMode('view')
                } catch (error) {
                    setNotice({kind: 'error', text: t('error.save', {reason: String(error?.message ?? error)})})
                } finally {
                    setBusy(false)
                }
            }

            const meta = [
                ...item.itemCount === null || item.itemCount === undefined ? [] : [t('meta.items', {count: item.itemCount})],
                ...item.tokenCount === null || item.tokenCount === undefined ? [] : [t('meta.tokens', {count: item.tokenCount})],
            ].join('\u2002·\u2002')
            const preview = String(item.current ?? '').replace(/\s+/gu, ' ').trim()
            const details = meta === '' ? preview : `${meta}\n${preview}`

            const bar = h('div', {className: 'cse-bar'},
                h('span', {className: 'cse-glyph', 'aria-hidden': 'true'}, h(Glyph)),
                h('span', {className: 'cse-label'}, t('title')),
                item.edited ? h('span', {className: 'cse-flag'}, t('meta.edited')) : null,
                h('span', {className: 'cse-meta', title: details}, preview),
                h('div', {className: 'cse-actions'},
                    editable
                        ? h('button', {
                            type: 'button',
                            className: 'cse-textbtn',
                            disabled: locked,
                            title: running === true ? t('hint.running') : t('action.edit'),
                            onClick: () => {
                                open('edit')
                            },
                        }, t('action.edit'))
                        : null,
                    h('button', {
                        type: 'button',
                        className: 'cse-icon',
                        disabled: busy,
                        'aria-label': mode === 'closed' ? t('action.show') : t('action.hide'),
                        'aria-expanded': mode !== 'closed',
                        title: mode === 'closed' ? t('action.show') : t('action.hide'),
                        onClick: () => {
                            open(mode === 'closed' ? 'view' : 'closed')
                        },
                    }, h('span', {className: 'cse-chevron', 'data-open': String(mode !== 'closed')}, h(Chevron)))))

            let panel = null
            if (mode === 'view') {
                panel = h('div', {className: 'cse-panel'},
                    h('pre', {className: 'cse-text'}, item.current),
                    editable ? null : h('span', {className: 'cse-hint'}, t('state.unframed')),
                    h('div', {className: 'cse-foot'},
                        h('span', {className: 'cse-hint'}, [
                            t('hint.marker'),
                            item.edited ? ` ${t('hint.original')}` : '',
                        ].join('')),
                        h('div', {className: 'cse-buttons'},
                            editable
                                ? h('button', {
                                    type: 'button',
                                    className: 'cse-textbtn',
                                    disabled: locked || !item.edited,
                                    onClick: () => {
                                        void send({restore: true})
                                    },
                                }, t('action.restore'))
                                : null,
                            editable
                                ? h('button', {
                                    type: 'button',
                                    className: 'cse-textbtn',
                                    disabled: locked,
                                    onClick: () => {
                                        open('edit')
                                    },
                                }, t('action.edit'))
                                : null)))
            } else if (mode === 'edit') {
                panel = h('div', {className: 'cse-panel'},
                    h('textarea', {
                        className: 'cse-textarea',
                        value: draft,
                        'aria-label': t('label.textarea'),
                        spellCheck: false,
                        autoFocus: true,
                        onChange: event => {
                            setDraft(event.target.value)
                        },
                        onKeyDown: event => {
                            if (event.key === 'Escape' && !busy) {
                                event.preventDefault()
                                setMode('view')
                                setNotice(null)
                            }
                        },
                    }),
                    h('div', {className: 'cse-foot'},
                        h('span', {className: 'cse-hint'}, running === true ? t('hint.running') : t('hint.edit')),
                        h('div', {className: 'cse-buttons'},
                            h('button', {
                                type: 'button',
                                className: 'cse-textbtn',
                                disabled: busy,
                                onClick: () => {
                                    setMode('view');
                                    setNotice(null)
                                },
                            }, t('action.cancel')),
                            h('button', {
                                type: 'button',
                                className: 'cse-textbtn',
                                disabled: locked || draft.trim() === '',
                                onClick: () => {
                                    void send({text: draft})
                                },
                            }, t('action.save')))))
            }

            return h('section', {className: 'cse-card', 'aria-label': t('title')},
                bar,
                notice === null ? null : h('div', {
                    className: 'cse-notice',
                    'data-kind': notice.kind,
                    role: notice.kind === 'error' ? 'alert' : 'status'
                }, notice.text),
                panel)
        }

        /** Dock entry: one row per live checkpoint, or nothing at all. */
        function Dock(props) {
            const projection = props.useProjection(PROJECTION_KEY)
            const items = projection !== null && typeof projection === 'object' && Array.isArray(projection.items)
                ? projection.items
                : []
            const running = props.useSessionStatus(map => map.get(props.sessionId)?.running === true)
            if (items.length === 0) return null
            const t = typeof props.t === 'function' ? props.t : props.fallbackT
            return h('div', {className: 'cse-dock', 'data-compaction-summary-editor': ''},
                h('style', null, CSS),
                items.map(item => h(Row, {
                    // Keyed by transaction identity, not by checkpoint seq: one edit moves
                    // the checkpoint to a new seq and the row must keep its local state.
                    key: `${props.sessionId}:${item.id}`,
                    item,
                    sessionId: props.sessionId,
                    running,
                    t,
                    getCommands: props.getCommands,
                    getLang: props.getLang,
                })))
        }

        /** Read the locale service snapshot without throwing when it is absent. */
        function readLanguage(ctx) {
            try {
                const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
                const active = String(locale?.getSnapshot?.()?.active ?? '')
                if (active !== '') return active.startsWith('zh') ? 'zh' : 'en'
            } catch {
                // Fall through to the browser hint.
            }
            const heading = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '')
            return heading.startsWith('zh') ? 'zh' : 'en'
        }

        return {
            // `remote.commands` is the mounted Remote namespace: a nested Cordis service
            // that must be injected by its full name, exactly like the shipped
            // client command service does.
            inject: ['slots', 'locale', 'remote.commands'],
            apply(ctx) {
                const fallbackT = makeFallback(readLanguage(ctx))
                ctx.effect(() => ctx.locale.register(NS, {en: EN, zh: ZH}), 'compaction-summary-editor locale')
                const readCommands = () => ctx.get('remote.commands')
                ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
                    name: 'conversation.input.dock',
                    id: 'compaction-summary-editor',
                    order: 30,
                    locale: NS,
                }, props => h(Dock, {
                    ...props,
                    fallbackT,
                    getCommands: readCommands,
                    getLang: () => readLanguage(ctx),
                })))
            },
        }
    },
})

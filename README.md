# dsh-compaction-summary-editor

A DeepSeek Harness (DSH) bundle plugin that lets you review and rewrite the summary a context
compaction lands in the conversation — the text the model reads as established background for the
compacted history.

[中文](#中文)

## What it does

When DSH compacts older history (automatically, or via `/compact`), the compacted span is replaced by
one user-role checkpoint message whose body is a model-written summary. That text is model-visible
history, so this plugin lets the user correct it:

- A slim bar appears above the message composer in every session with a live compaction checkpoint.
- Expand it to read the exact text the model currently reads.
- **Edit** rewrites that checkpoint in the session surface, so later model requests read your text.
- **Restore original** brings back the summary the model produced (it stays in the session log).
- Saving needs an idle agent; the bar refuses to rewrite while a turn is running.

The bar covers a checkpoint only while it is still live in the open session (a later compaction
supersedes it). The transcript's own "context compacted" marker keeps showing the model-produced
summary. Each save leaves one log-only `compaction-summary-edit` command row that never reaches the
model. No model tool is added: only the user may rewrite model-visible history.

## Requirements

- DSH `>=0.2.2-rc.3 <0.3.0` (`engines.dsh`).
- The Web client (`dsh web` or Desktop): the editor is a composer-dock UI plugin.
- A compaction backend that writes the `<compacted-summary>` checkpoint envelope (`@deepseek-ai/dsh-compaction-basic`).
  Other envelopes are shown read-only.

## Layout

| Path                | Role                                                                                      |
|---------------------|-------------------------------------------------------------------------------------------|
| `index.js`          | Host half: `compactionSummaryEdit` session projection + `compaction-summary-edit` command |
| `lib/projection.js` | Pure fold: live checkpoint identity, current text, original summary, framing              |
| `lib/edit.js`       | One edit: resolve the target by compaction identity, append the surface replacement       |
| `client.js`         | Browser half: composer-dock bar, view/edit panel, `remote.commands` bridge                |
| `cordis.patch.yml`  | Bundle patch inserting the plugin row                                                     |
| `locale/*.json`     | Display metadata (title, description, detail document)                                    |
| `docs/`             | Plugin-detail document and its illustration                                               |


## License

MIT — see [LICENSE](LICENSE).

---

## 中文

DSH 做上下文压缩时，会把较早的历史替换成一条由模型写的摘要检查点，这段摘要是模型可见的历史。
本插件在消息输入框上方给出摘要栏：展开可以看到模型当前读到的确切文本；「编辑」改写该检查点，
后续模型请求读到的就是你的文本；「恢复原始」可还原模型生成的摘要（仍保存在会话日志里）。
智能体运行期间不允许保存。

已知限制：摘要栏只覆盖当前会话中仍生效的压缩检查点；对话记录里的「上下文已压缩」标记仍显示模型
生成的原始摘要，并会在保存后移动到编辑发生的位置；每次保存会留下一条模型看不到的
`compaction-summary-edit` 记录。

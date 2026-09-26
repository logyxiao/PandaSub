import { ArrowRight, BookOpen, Check, Eye, FileUp, Mail, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui'
import {
  editorRecipient,
  fillPlaceholders
} from '../planShared'
import type { PlanEditorModel } from './usePlanEditor'
export function PlanContentStep({ model }: { model: PlanEditorModel }) {
  const {
    fileRef, importManuscript, dragging, form, importing, dragDepth,
    setDragging, setForm, lengthChips, excluded, togglePlanTag, excludePlanTag,
    genreChips, editors, addTemplate, mailTemplates, removeTemplate, fixedTemplate,
    setActiveTplId, activeTpl, writeTemplates, tplMode, setTplMode, selectedEditors,
    updateActiveTpl, goToStep2,
  } = model
  return ((
    <section className="plan-step-1">
      <div className="plan-step-1-split">
        <div className="plan-work-card plan-step-1-left">
          <div className="plan-content-heading">
            <span className="plan-content-icon"><BookOpen size={20} strokeWidth={1.7} /></span>
            <div><h3>投稿作品</h3><p>导入稿件，再补充作品信息。</p></div>
          </div>
          <div className="plan-file-title">
            <input ref={fileRef} type="file" accept=".docx,.txt,.md,.html,.htm" hidden
              onChange={(e) => { void importManuscript(e.target.files); e.target.value = '' }} />
            <button type="button"
              className={`plan-drop ${dragging ? 'is-over' : ''} ${form.file_name ? 'has-file' : ''}`}
              aria-label={form.file_name ? '拖拽或点击替换稿件' : '拖拽或点击导入稿件'}
              aria-describedby="plan-drop-description"
              aria-busy={importing}
              disabled={importing}
              onClick={() => fileRef.current?.click()}
              onDragEnter={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                dragDepth.current += 1
                setDragging(true)
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = importing ? 'none' : 'copy'
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                dragDepth.current = Math.max(0, dragDepth.current - 1)
                if (!dragDepth.current) setDragging(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                dragDepth.current = 0
                setDragging(false)
                void importManuscript(e.dataTransfer.files)
              }}
            >
              <span className="plan-drop-document" aria-hidden="true">
                <FileUp size={32} strokeWidth={1.5} />
                {form.file_name && <span className="plan-drop-check"><Check size={12} /></span>}
              </span>
              <span className="plan-drop-title" aria-live="polite">
                {importing ? '正在读入稿件…' : dragging ? (form.file_name ? '松开鼠标，替换稿件' : '松开鼠标，导入稿件') : form.file_name || '把稿件拖到这里'}
              </span>
              <span className="plan-drop-description" id="plan-drop-description">
                {form.file_name ? '已作为投稿附件 · 可拖入新文件替换' : '自动读取作品名称和字数，随投稿邮件附上原稿'}
              </span>
              <span className="plan-drop-formats" aria-label="支持的文件格式">
                <span>DOCX</span><span>TXT</span><span>MD</span><span>HTML</span>
              </span>
              <span className="plan-drop-browse">{form.file_name ? '或点击替换文件' : '也可以点击上传'}</span>
            </button>
          </div>
          <div className="plan-title-row">
            <label className="plan-content-field">作品名称
              <input className="plan-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="作品名称" />
            </label>
            <label className="plan-word-count plan-content-field">作品字数
              <input type="number" min={0} value={form.word_count || ''}
                placeholder="自动读取"
                onChange={(e) => setForm({ ...form, word_count: Number(e.target.value) || 0 })} />
            </label>
          </div>

          <div className="plan-genre-row">
            <div className="plan-filter-heading"><strong>作品篇幅</strong><span>按字数推荐，可多选</span></div>
            <div className="field-filter-chips">
              {lengthChips.map(([tag, count]) => (
                <button type="button" key={tag}
                  aria-pressed={form.genres.includes(tag)}
                  className={`field-chip ${form.genres.includes(tag) ? 'on' : ''} ${excluded.includes(tag) ? 'is-excluded' : ''}`}
                  onClick={() => togglePlanTag(tag)}
                  onContextMenu={(ev) => { ev.preventDefault(); excludePlanTag(tag) }}>
                  {tag}{count > 0 && <small>{count}</small>}
                </button>
              ))}
            </div>
          </div>

          <div className="plan-genre-row is-grow">
            <div className="plan-filter-heading"><strong>作品类型</strong><span>可多选 · 右键排除</span></div>
            {genreChips.length ? (
              <div className="field-filter-chips">
                {genreChips.map(([tag, count]) => (
                  <button type="button" key={tag} title="左键筛选，右键排除"
                    aria-pressed={form.genres.includes(tag)}
                    className={`field-chip ${form.genres.includes(tag) ? 'on' : ''} ${excluded.includes(tag) ? 'is-excluded' : ''}`}
                    onClick={() => togglePlanTag(tag)}
                    onContextMenu={(ev) => { ev.preventDefault(); excludePlanTag(tag) }}>
                    {tag}{count > 0 && <small>{count}</small>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="field-filter-empty">
                {editors.length
                  ? '编辑库里还没有作品类型。去编辑页补上后再筛。'
                  : '还没有编辑，先去编辑页存收稿人。'}
              </p>
            )}
            <p className="plan-filter-hint">下一步将根据篇幅和类型，为你匹配收稿编辑。</p>
          </div>
        </div>

        <div className="plan-work-card plan-step-1-right">
          <div className="plan-tpl-head">
            <div className="plan-content-heading">
              <span className="plan-content-icon"><Mail size={20} strokeWidth={1.7} /></span>
              <div><h3>邮件模板</h3><p>写给编辑的话，随稿件一起发送。</p></div>
            </div>
            <div className="plan-tpl-head-actions">
              <Button size="sm" onClick={addTemplate}><Plus size={14} />新增</Button>
              <Button size="sm" variant="ghost" className="plan-tpl-delete" disabled={mailTemplates.length <= 1} onClick={removeTemplate}>
                <Trash2 size={14} />删除
              </Button>
            </div>
          </div>
          <label className="plan-tpl-strategy">
            <span><strong>发送时使用</strong><small>{fixedTemplate ? '每封邮件使用同一套模板' : `从 ${mailTemplates.length} 套模板中随机选用`}</small></span>
            <select
              value={form.fixed_mail_template_id}
              onChange={(e) => {
                const id = e.target.value
                setForm((f) => ({ ...f, fixed_mail_template_id: id }))
                if (id) setActiveTplId(id)
              }}
            >
              <option value="">每封随机选择（默认）</option>
              {mailTemplates.map((item, index) => (
                <option key={item.id} value={item.id}>固定使用：{item.name.trim() || `模板 ${index + 1}`}</option>
              ))}
            </select>
          </label>
          <div className="plan-tpl-toolbar">
            <div className="plan-tpl-tabs" role="tablist" aria-label="邮件模板">
              {mailTemplates.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={item.id === activeTpl?.id}
                  className={`plan-tpl-tab ${item.id === activeTpl?.id ? 'on' : ''}`}
                  onClick={() => { writeTemplates(mailTemplates, item.id); setActiveTplId(item.id) }}
                >
                  {item.name.trim() || `模板 ${index + 1}`}
                </button>
              ))}
            </div>
            {activeTpl && (
              <div className="plan-tpl-mode" role="group" aria-label="模板视图">
                <button type="button" aria-pressed={tplMode === 'preview'} className={`plan-tpl-mode-btn ${tplMode === 'preview' ? 'is-on' : ''}`}
                  onClick={() => setTplMode('preview')}><Eye size={14} />预览</button>
                <button type="button" aria-pressed={tplMode === 'edit'} className={`plan-tpl-mode-btn ${tplMode === 'edit' ? 'is-on' : ''}`}
                  onClick={() => setTplMode('edit')}><Pencil size={14} />编辑</button>
              </div>
            )}
          </div>
          {activeTpl && (
            <>
              {tplMode === 'preview' ? (
                <div className="plan-tpl-preview">
                  <p className="plan-tpl-preview-kicker">邮件主题</p>
                  <h4 className="plan-tpl-preview-subject">
                    {fillPlaceholders(
                      activeTpl.subject.trim() || '投稿：《{{作品名}}》',
                      selectedEditors[0] ? editorRecipient(selectedEditors[0]) : '',
                      form.title,
                      { wordCount: form.word_count, genres: form.genres, category: form.category, asSubject: true },
                    ) || '（标题为空）'}
                  </h4>
                  <pre className="plan-tpl-preview-body">
                    {fillPlaceholders(
                      activeTpl.body,
                      selectedEditors[0] ? editorRecipient(selectedEditors[0]) : '',
                      form.title,
                      { wordCount: form.word_count, genres: form.genres, category: form.category },
                    ) || '这套模板还没有正文'}
                  </pre>
                  <p className="plan-tpl-hint">预览已代入作品信息；未选类型时，自动省略「类型：」一行。</p>
                </div>
              ) : (
                <div className="plan-tpl-editor">
                  <label className="plan-tpl-name">模板名称
                    <input value={activeTpl.name} onChange={(e) => updateActiveTpl({ name: e.target.value })} placeholder="例如：常规问候" />
                  </label>
                  <label className="plan-tpl-name">邮件主题
                    <input
                      className="plan-tpl-subject"
                      value={activeTpl.subject}
                      onChange={(e) => updateActiveTpl({ subject: e.target.value })}
                      placeholder="投稿：《{{作品名}}》+{{字数}}+{{类型}}"
                    />
                  </label>
                  <div className="plan-tpl-body-field">
                    <label htmlFor="plan-template-body">邮件正文</label>
                    <textarea
                      id="plan-template-body"
                      className="plan-body"
                      value={activeTpl.body}
                      onChange={(e) => updateActiveTpl({ body: e.target.value })}
                      placeholder={'编辑老师您好：\n\n现将作品《{{作品名}}》投至贵处，请审阅。'}
                    />
                  </div>
                  <p className="plan-tpl-hint">标题建议带 {'{{字数}}'} 和 {'{{类型}}'}（不含短篇 / 中短篇）。正文可用 {'{{作品名}}'} {'{{篇幅}}'} {'{{字数}}'} {'{{类型}}'}。没选类型时不会带上「类型：」。</p>
                </div>
              )}
            </>
          )}
          <p className="plan-tpl-save-note">修改模板后，会自动保存为新计划的默认模板。</p>
        </div>
      </div>
      <div className="step-actions plan-content-actions">
        <span><Paperclip size={15} />{form.file_name ? `投稿附件：${form.file_name}` : '原稿将作为附件，邮件正文使用右侧模板'}</span>
        <Button variant="primary" onClick={() => goToStep2()}>下一步：选择编辑<ArrowRight size={16} /></Button>
      </div>
    </section>
  ))
}

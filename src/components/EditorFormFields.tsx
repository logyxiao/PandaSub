import { useId, useMemo } from 'react'
import type { EditorInput } from '../types'
import { GENRES } from '../views/planShared'
import { EditorTagField } from './EditorTags'

export function EditorFormFields({ value, onChange, platforms = [], tags = [], disabled = false, source }: {
  value: EditorInput
  onChange: (value: EditorInput) => void
  platforms?: string[]
  tags?: string[]
  disabled?: boolean
  source?: string
}) {
  const platformId = useId()
  const options = useMemo(() => [...new Set([...tags, ...GENRES, ...value.work_type, ...(value.rejected_types ?? [])])], [tags, value.work_type, value.rejected_types])
  return <>
    <fieldset className="form-grid editor-form-fields" disabled={disabled}>
      <label className="field">平台<input value={value.platform} onChange={e => onChange({ ...value, platform: e.target.value })} placeholder="选填，例如：起点、晋江" list={platformId} /></label>
      <label className="field">名称<input value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} placeholder="选填，编辑或栏目名" /></label>
      <label className="field span2">收稿邮箱（必填）<input value={value.email} onChange={e => onChange({ ...value, email: e.target.value })} placeholder="editor@example.com" /></label>
      <div className="field span2">收稿类型
        <EditorTagField label="收稿类型" values={value.work_type} options={options} disabled={disabled}
          onChange={work_type => onChange({ ...value, work_type, rejected_types: (value.rejected_types ?? []).filter(tag => !work_type.includes(tag)) })} />
        <span className="field-hint">支持多选，选择标签后再保存编辑资料。</span>
      </div>
      <div className="field span2">拒收类型
        <EditorTagField label="拒收类型" values={value.rejected_types ?? []} options={options} disabled={disabled} excluded
          onChange={rejected_types => onChange({ ...value, rejected_types, work_type: value.work_type.filter(tag => !rejected_types.includes(tag)) })} />
        <span className="field-hint">同一类型不会同时收稿和拒收；修改一侧会从另一侧移除。</span>
      </div>
      <label className="field span2">收稿说明<textarea className="editor-notes" rows={4} value={value.notes} onChange={e => onChange({ ...value, notes: e.target.value })} placeholder="审稿、结算、收稿方向、不收题材等，选填" /></label>
      {source && <p className="field-hint span2">当前来源：{source}。保存后会记为手动数据。</p>}
    </fieldset>
    <datalist id={platformId}>{platforms.map(platform => <option key={platform} value={platform} />)}</datalist>
  </>
}

import { ArrowLeft } from 'lucide-react'
import { EditorFormFields } from '../components/EditorFormFields'
import { GroupMemberPicker } from '../components/GroupMemberPicker'
import { Modal } from '../components/Modal'
import { Button } from '../components/ui'
import { PlanContentStep } from './plan/PlanContentStep'
import { PlanRecipientsStep } from './plan/PlanRecipientsStep'
import { PlanSendStep } from './plan/PlanSendStep'
import { usePlanEditor, type PlanEditorProps } from './plan/usePlanEditor'

export function PlanEditor(props: PlanEditorProps) {
  const model = usePlanEditor(props)
  const {
    steps, onClose, form, editing, step, goToStep2,
    goToStep3, setStep, saving, onSaveDraft, editors, showPlanMembers,
    setShowPlanMembers, planMemberDraft, setGroupPlanIds, setPlanMemberDraft, showGroupForm, editingGroup,
    setShowGroupForm, groupMemberIds, savingGroup, groupName, saveEditorGroup, setGroupMemberIds,
    setGroupName, showEditorForm, editingEditor, setShowEditorForm, savingEditor, saveEditor,
    editorForm, setEditorForm, platforms, workTypeOptions,
  } = model
  return (
    <div className="plan-desk" onPointerDownCapture={props.onInteraction} onKeyDownCapture={props.onInteraction} onChangeCapture={props.onInteraction} onDropCapture={props.onInteraction}>
      <header className="plan-bar">
        <div className="plan-bar-left">
          <button className="plan-back" onClick={onClose}><ArrowLeft size={16} />返回</button>
          <strong className="plan-bar-name">{form.title.trim() || (editing ? '编辑计划' : '新建计划')}</strong>
        </div>
        <div className="plan-steps" role="tablist" aria-label="新建投稿步骤">
          {steps.map((s) => (
            <button key={s.n} type="button" role="tab" aria-selected={step === s.n}
              className={`plan-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`}
              onClick={() => {
                if (s.n === 2) goToStep2()
                else if (s.n === 3 && step === 2) goToStep3()
                else setStep(s.n)
              }}>
              <i>{s.n}</i>{s.label}
            </button>
          ))}
        </div>
        <div className="plan-bar-actions">
          <Button variant="ghost" disabled={saving} onClick={onSaveDraft}>保存草稿</Button>
        </div>
      </header>

      <div className="plan-step-body">
        {step === 1 && <PlanContentStep model={model} />}

        {step === 2 && <PlanRecipientsStep model={model} />}

        {step === 3 && <PlanSendStep model={model} />}
      </div>

      {showPlanMembers && (
        <Modal title="调整这次名单" width={960} className="group-member-modal" onClose={() => setShowPlanMembers(false)}
          footer={<>
            <span className="editor-group-selected-count">已选 {planMemberDraft.size} 位</span>
            <Button variant="ghost" onClick={() => setShowPlanMembers(false)}>取消</Button>
            <Button variant="primary" onClick={() => {
              setGroupPlanIds(new Set(planMemberDraft))
              setShowPlanMembers(false)
            }}>用于这次计划</Button>
          </>}>
          <p className="hint">只改这次投稿，不会动原来的编辑组。</p>
          <GroupMemberPicker editors={editors} selectedIds={planMemberDraft} onChange={setPlanMemberDraft} />
        </Modal>
      )}

      {showGroupForm && (
        <Modal title={editingGroup ? '管理成员' : '新建编辑组'} width={960} className="group-member-modal"
          onClose={() => setShowGroupForm(false)}
          footer={
            <>
              <span className="editor-group-selected-count">已选 {groupMemberIds.size} 位</span>
              <Button variant="ghost" onClick={() => setShowGroupForm(false)}>取消</Button>
              <Button variant="primary" disabled={savingGroup || !groupName.trim() || !groupMemberIds.size}
                onClick={() => void saveEditorGroup()}>
                {savingGroup ? '保存中…' : '保存'}
              </Button>
            </>
          }>
          <GroupMemberPicker editors={editors} selectedIds={groupMemberIds} onChange={setGroupMemberIds} header={
            <div className="editor-group-form-head">
              <label className="field">编辑组名称
                <input autoFocus={!editingGroup} maxLength={40} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：短篇常投、重点编辑" />
              </label>
            </div>
          } />
        </Modal>
      )}

      {showEditorForm && (
        <Modal title={editingEditor ? '修改编辑资料' : '添加编辑'} width={560}
          onClose={() => setShowEditorForm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setShowEditorForm(false)}>取消</Button>
              <Button variant="primary" disabled={savingEditor} onClick={() => void saveEditor()}>
                {editingEditor ? '保存修改' : '保存到编辑库'}
              </Button>
            </>
          }>
          <EditorFormFields value={editorForm} onChange={setEditorForm} platforms={platforms}
            tags={workTypeOptions.map(([tag]) => tag)} disabled={savingEditor} source={editingEditor ? editingEditor.source || '手动数据' : undefined} />
        </Modal>
      )}
    </div>
  )
}

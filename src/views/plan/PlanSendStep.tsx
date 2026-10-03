import { useState } from 'react'
import { ArrowLeft, BookOpen, Clock3, Copy, Eye, Mail, Send } from 'lucide-react'
import { AccountPicker } from '../../components/AccountPicker'
import { SendIntervalField } from '../../components/SendIntervalField'
import { Button, Select } from '../../components/ui'
import type { PlanEditorModel } from './usePlanEditor'
export function PlanSendStep({ model }: { model: PlanEditorModel }) {
  const {
    sendCount, copyEditorList, enabledAccounts, selectedAccounts, taskForm, toggleAccount,
    form, sendIntervalTouched, setSendIntervalTouched, updateSendInterval, sendIntervalValid, minutes,
    orphans, overQuotaAccounts, ready, blockers, setStep, saving,
    testing, testSend, onSaveAndSend, setTaskForm, scheduledInput, setScheduledInput, scheduleValid, previousTasks,
  } = model
  const [customDelay, setCustomDelay] = useState(() => ![30, 60, 120].includes(taskForm.delay_minutes ?? 30))
  return ((
    <section className="plan-step-3">
      <div className="plan-step-3-split">
        <div className="plan-work-card plan-step-3-left">
          <div className="plan-send-head">
            <div className="plan-content-heading">
              <span className="plan-content-icon"><Mail size={20} strokeWidth={1.7} /></span>
              <div><h3>选择发送邮箱</h3><p>可多选，发送时按顺序轮流使用。</p></div>
            </div>
            <Button size="sm" disabled={!sendCount} onClick={() => void copyEditorList()}>
              <Copy size={14} />复制编辑列表
            </Button>
          </div>
          <div className="plan-account-caption"><strong>可用邮箱 <span>{enabledAccounts.length}</span></strong><span>已选 {selectedAccounts.length} 个</span></div>
          <AccountPicker accounts={enabledAccounts} selectedIds={taskForm.account_ids} onToggle={toggleAccount} />
          <div className="plan-copy-note"><Copy size={16} /><p className="plan-copy-hint">也可以复制收稿邮箱，粘贴到 QQ 邮箱「群发」收件人中，自行发送。</p></div>
        </div>

        <div className="plan-work-card plan-step-3-right">
          <div className="plan-content-heading">
            <span className="plan-content-icon"><Clock3 size={20} strokeWidth={1.7} /></span>
            <div><h3>发送设置</h3><p>每封邮件发完后，随机等待一段时间再发下一封。</p></div>
          </div>
          <div className="plan-schedule-field">
            <label className="field">开始发送方式
              <Select ariaLabel="开始发送方式" value={taskForm.schedule_type} disabled={saving}
                options={[{ value: 'immediate', label: '立即发送' }, { value: 'scheduled', label: '定时开始发送' }, { value: 'after_previous', label: '上个计划结束后发送' }, ...(taskForm.schedule_type === 'loop' ? [{ value: 'loop', label: '循环本计划' }] : [])]}
                onChange={value => setTaskForm(current => ({ ...current, schedule_type: value as typeof current.schedule_type, after_task_id: current.after_task_id ?? previousTasks[0]?.id ?? null, delay_minutes: current.delay_minutes || 30 }))} />
            </label>
            {taskForm.schedule_type === 'after_previous' && <>
              <label className="field">等待哪个投稿计划
                <Select ariaLabel="等待的投稿计划" value={taskForm.after_task_id ?? ''} disabled={saving} searchable
                  options={[{ value: '', label: '请选择上个计划' }, ...previousTasks.map(task => ({ value: task.id, label: `${task.name}（#${task.id}）` }))]}
                  onChange={value => setTaskForm(current => ({ ...current, after_task_id: value === '' ? null : Number(value) }))} />
              </label>
              <label className="field">结束后等待
                <Select ariaLabel="结束后等待" value={customDelay ? 'custom' : taskForm.delay_minutes ?? 30} disabled={saving}
                  options={[{ value: 30, label: '半小时' }, { value: 60, label: '1 小时' }, { value: 120, label: '2 小时' }, { value: 'custom', label: '自定义分钟数' }]}
                  onChange={value => { setCustomDelay(value === 'custom'); setTaskForm(current => ({ ...current, delay_minutes: value === 'custom' ? 45 : Number(value) })) }} />
              </label>
              {customDelay && <label className="field">延迟分钟数
                <input type="number" aria-label="延迟分钟数" min={1} max={10080} step={1} disabled={saving} value={taskForm.delay_minutes || ''}
                  onChange={event => setTaskForm(current => ({ ...current, delay_minutes: Number(event.target.value) }))} />
              </label>}
              {!previousTasks.length && <p className="warn-text">还没有可等待的前序计划，请先创建一个其他投稿计划。</p>}
              <p className="hint">从所选计划实际发送结束时开始计时，含手动停止或失败结束；暂停、尚未开始或取消预约不触发。循环计划需停止后才开始计时。请保持应用运行、电脑唤醒且联网。</p>
            </>}
            {taskForm.schedule_type === 'scheduled' && <>
              <label className="field">开始时间（电脑本地时间）
                <input type="datetime-local" aria-label="定时开始时间" step={60} value={scheduledInput} disabled={saving}
                  aria-invalid={!!scheduledInput && !scheduleValid} onChange={event => setScheduledInput(event.target.value)} />
              </label>
              {scheduledInput && !scheduleValid && <p className="warn-text" role="alert">请选择晚于现在的有效时间。</p>}
              <p className="hint">预约后到点自动开始，检查间隔约 15 秒。请保持应用运行、电脑唤醒且网络可用；退出或休眠期间错过的预约，会在恢复运行后开始。</p>
            </>}
          </div>
          <SendIntervalField fromSec={form.send_interval_from_sec} toSec={form.send_interval_to_sec}
            touched={sendIntervalTouched} onBlur={() => setSendIntervalTouched(true)} onChange={updateSendInterval} />
          <p className="plan-send-desc">
            {sendIntervalValid
              ? `当前每封间隔 ${form.send_interval_from_sec}–${form.send_interval_to_sec} 秒；保存后会作为下次新建计划的默认间隔。`
              : sendIntervalTouched
                ? '请填写 1–86400 秒，且最短时间需小于或等于最长时间。'
                : '完成两个时间输入后会校验发送区间。'}
          </p>
          {sendIntervalValid && form.send_interval_from_sec < 30 && (
            <p className="warn-text">最短间隔低于 30 秒，可能更容易触发邮箱发送频率限制。</p>
          )}
          <div className="plan-send-review">
            <p className="plan-send-desc">自动投递遇到编辑拉黑时，会保持发件邮箱不变，尝试同平台未发现拉黑记录的可用编辑；无可用编辑则跳过。替换详情会在界面提示并写入发送记录。</p>
            <h4>本次投递</h4>
            <dl className="plan-send-metrics">
              <div><dt>待发送</dt><dd>{sendCount}<small>封</small></dd></div>
              <div><dt>发件邮箱</dt><dd>{selectedAccounts.length}<small>个</small></dd></div>
              <div><dt>预计用时</dt><dd>{sendCount > 0 && sendIntervalValid ? minutes : '—'}<small>分钟</small></dd></div>
            </dl>
            <div className="plan-send-manuscript"><BookOpen size={16} /><span><b>{form.title.trim() || '尚未填写作品名称'}</b><small>{form.file_name ? `附件：${form.file_name}` : '尚未添加稿件附件'}</small></span></div>
            {!!orphans.length && <p className="plan-send-desc">含 {orphans.length} 位不在编辑库中的收件人。</p>}
          </div>
          {overQuotaAccounts.length > 0 && (
            <p className="warn-text">
              {overQuotaAccounts.map((account) => account.email).join('、')} 今日已达建议 80 封，建议今天不要再用这些邮箱发送。
            </p>
          )}
          {!enabledAccounts.length && <p className="warn-text">还没有可用发件邮箱，只能先存草稿。</p>}
          {!ready && blockers.length > 0 && (
            <p className="warn-text">还不能发送：{blockers.join('、')}。测试发送会把一封预览邮件发到你的发件邮箱（勾选的第一个邮箱），不会发给编辑。</p>
          )}
        </div>
      </div>
      <div className="step-actions plan-content-actions">
        <span><Eye size={15} />测试邮件仅发给当前选中的第一个发件邮箱</span>
        <div className="plan-footer-buttons">
          <Button onClick={() => setStep(2)}><ArrowLeft size={15} />上一步</Button>
          <Button variant="ghost" disabled={saving || testing} onClick={() => void testSend()}>
            {testing ? '发送中…' : '测试发送'}
          </Button>
          <Button variant="primary" disabled={saving || !ready} onClick={() => onSaveAndSend()}>
            <Send size={15} />{saving ? '保存中…' : ['scheduled', 'after_previous'].includes(taskForm.schedule_type) ? '预约发送' : '开始发送'}
          </Button>
        </div>
      </div>
    </section>
  ))
}

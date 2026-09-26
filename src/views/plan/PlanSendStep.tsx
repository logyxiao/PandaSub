import { ArrowLeft, BookOpen, Clock3, Copy, Eye, Mail, Send } from 'lucide-react'
import { AccountPicker } from '../../components/AccountPicker'
import { SendIntervalField } from '../../components/SendIntervalField'
import { Button } from '../../components/ui'
import type { PlanEditorModel } from './usePlanEditor'
export function PlanSendStep({ model }: { model: PlanEditorModel }) {
  const {
    sendCount, copyEditorList, enabledAccounts, selectedAccounts, taskForm, toggleAccount,
    form, sendIntervalTouched, setSendIntervalTouched, updateSendInterval, sendIntervalValid, minutes,
    orphans, overQuotaAccounts, ready, blockers, setStep, saving,
    testing, testSend, onSaveAndSend,
  } = model
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
          <SendIntervalField fromSec={form.send_interval_from_sec} toSec={form.send_interval_to_sec}
            touched={sendIntervalTouched} onBlur={() => setSendIntervalTouched(true)} onChange={updateSendInterval} />
          <p className="plan-send-desc">
            {sendIntervalValid
              ? `当前每封间隔 ${form.send_interval_from_sec}–${form.send_interval_to_sec} 秒，默认 100–240 秒。`
              : sendIntervalTouched
                ? '请填写 1–86400 秒，且最短时间需小于或等于最长时间。'
                : '完成两个时间输入后会校验发送区间。'}
          </p>
          {sendIntervalValid && form.send_interval_from_sec < 30 && (
            <p className="warn-text">最短间隔低于 30 秒，可能更容易触发邮箱发送频率限制。</p>
          )}
          <div className="plan-send-review">
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
            <Send size={15} />开始发送
          </Button>
        </div>
      </div>
    </section>
  ))
}

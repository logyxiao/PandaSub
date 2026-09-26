import { useEffect, useState } from 'react'
import { useToast } from '../../components/feedback'
import type { MailTemplate, ManuscriptInput } from '../../types'
import { defaultMailTemplates, isDroppedMailTemplate } from '../planShared'
import type { PlanEditorProps } from './usePlanEditor'

export function useMailTemplates(form: ManuscriptInput, setForm: PlanEditorProps['setForm'], onDefaultTemplatesChange: (templates: MailTemplate[]) => void) {
  const toast = useToast()
  const [activeTplId, setActiveTplId] = useState(() => form.fixed_mail_template_id || form.mail_templates[0]?.id || 't1')
  const [tplMode, setTplMode] = useState<'preview' | 'edit'>('preview')
  const mailTemplates = (form.mail_templates?.length ? form.mail_templates : defaultMailTemplates())
    .filter((item) => !isDroppedMailTemplate(item))
  const activeTpl = mailTemplates.find((item) => item.id === activeTplId) ?? mailTemplates[0]
  const fixedTemplate = mailTemplates.find((item) => item.id === form.fixed_mail_template_id)
  useEffect(() => {
    if (!form.mail_templates?.some(isDroppedMailTemplate)) return
    const kept = form.mail_templates.filter((item) => !isDroppedMailTemplate(item))
    const next = kept.length ? kept : defaultMailTemplates()
    const current = next.find((item) => item.id === activeTplId) ?? next[0]
    setForm((f) => ({ ...f, mail_templates: next, subject: current?.subject ?? f.subject, body: current?.body ?? f.body }))
    if (current && current.id !== activeTplId) setActiveTplId(current.id)
  }, [form.mail_templates, activeTplId, setForm])

  const writeTemplates = (next: MailTemplate[], currentId = activeTplId, saveAsDefault = false) => {
    const current = next.find((item) => item.id === currentId) ?? next[0]
    setForm((f) => ({
      ...f,
      mail_templates: next,
      fixed_mail_template_id: next.some((item) => item.id === f.fixed_mail_template_id)
        ? f.fixed_mail_template_id
        : '',
      subject: current?.subject ?? '',
      body: current?.body ?? '',
    }))
    if (saveAsDefault) onDefaultTemplatesChange(next)
  }

  const updateActiveTpl = (patch: Partial<MailTemplate>) => {
    if (!activeTpl) return
    writeTemplates(mailTemplates.map((item) => item.id === activeTpl.id ? { ...item, ...patch } : item), activeTpl.id, true)
  }

  const addTemplate = () => {
    const item: MailTemplate = {
      id: `tpl-${Date.now()}`,
      name: `模板 ${mailTemplates.length + 1}`,
      subject: '投稿：《{{作品名}}》+{{字数}}+{{类型}}',
      body: '编辑老师您好：\n\n现将作品《{{作品名}}》投至贵处，恳请审阅。完整稿件已随信附上，谢谢。',
    }
    writeTemplates([...mailTemplates, item], item.id, true)
    setActiveTplId(item.id)
    setTplMode('edit')
  }

  const removeTemplate = () => {
    if (!activeTpl || mailTemplates.length <= 1) {
      toast('至少保留一套模板', 'warning')
      return
    }
    const index = mailTemplates.findIndex((item) => item.id === activeTpl.id)
    const next = mailTemplates.filter((item) => item.id !== activeTpl.id)
    const fallback = next[Math.max(0, index - 1)] ?? next[0]
    writeTemplates(next, fallback.id, true)
    setActiveTplId(fallback.id)
  }

  return { mailTemplates, activeTpl, fixedTemplate, setActiveTplId, tplMode, setTplMode, writeTemplates, updateActiveTpl, addTemplate, removeTemplate }
}

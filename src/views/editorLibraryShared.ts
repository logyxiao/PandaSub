import type { Editor, EditorInput } from '../types'
import { isValidEmail } from '../format'

export type TagMatchMode = 'any' | 'all'
export function splitEditorTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[，,、;；\n]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}
export function matchesEditorTags(
  editor: Pick<Editor, 'work_type'>,
  selected: readonly string[],
  excluded: readonly string[],
  mode: TagMatchMode,
) {
  if (excluded.some((tag) => editor.work_type.includes(tag))) return false
  return (
    !selected.length ||
    (mode === 'all'
      ? selected.every((tag) => editor.work_type.includes(tag))
      : selected.some((tag) => editor.work_type.includes(tag)))
  )
}
export function editorInput(editor: Editor): EditorInput {
  return {
    name: editor.name,
    platform: editor.platform,
    email: editor.email,
    work_type: [...editor.work_type],
    rejected_types: [...(editor.rejected_types ?? [])],
    notes: editor.notes ?? '',
  }
}
export function validateEditorInput(
  input: EditorInput,
  others: readonly Editor[],
  id?: number,
) {
  if (!isValidEmail(input.email.trim())) return '请填写有效的收稿邮箱'
  if (
    others.some(
      (e) =>
        e.id !== id &&
        e.email.trim().toLowerCase() === input.email.trim().toLowerCase(),
    )
  )
    return '这个邮箱已在编辑库中，请核对后再保存'
  return ''
}

import type { Editor } from '../types'
import type { EditorTagSelection } from '../components/EditorTags'
import { compareEditorsByFavorite, editorMatchesPlan, editorPlatformKey, pickRandomPlatformEditor } from '../views/planShared'
import { matchesEditorTags } from '../views/editorLibraryShared'

export function filterEditorText(items: readonly Editor[], query = '', platform = '') {
  const needle = query.trim().toLocaleLowerCase()
  return items.filter(editor => (!platform || editor.platform === platform)
    && (!needle || [editor.name, editor.email, editor.platform, editor.source, editor.notes,
      ...editor.work_type, ...(editor.rejected_types ?? [])].join(' ').toLocaleLowerCase().includes(needle)))
}

/** Build normalized text and stable ordering once per immutable editor snapshot. */
export function buildEditorSearchIndex(items: readonly Editor[]) {
  return items.map(editor => ({ editor, text: [editor.name, editor.email, editor.platform, editor.source, editor.notes,
    ...editor.work_type, ...(editor.rejected_types ?? [])].join(' ').toLocaleLowerCase() }))
    .sort((a, b) => compareEditorsByFavorite(a.editor, b.editor))
}
export function searchEditorIndex(index: ReturnType<typeof buildEditorSearchIndex>, query = '', platform = '') {
  const needle = query.trim().toLocaleLowerCase()
  return index.filter(({ editor, text }) => (!platform || editor.platform === platform) && (!needle || text.includes(needle))).map(row => row.editor)
}

export function pickPlatformEditors(items: readonly Editor[], selected: ReadonlySet<number> = new Set(), randomize = false) {
  const groups = new Map<string, Editor[]>()
  for (const editor of items) {
    const key = editorPlatformKey(editor)
    const peers = groups.get(key) ?? []
    peers.push(editor)
    groups.set(key, peers)
  }
  return [...groups.values()].flatMap(peers => {
    const chosen = peers.find(editor => selected.has(editor.id))
      ?? (randomize ? pickRandomPlatformEditor(peers) : peers[0])
    return chosen ? [chosen] : []
  })
}

export function matchEditorResults(items: readonly Editor[], selection: EditorTagSelection, plan = false, presorted = false) {
  const matches = items.filter(editor => plan ? editorMatchesPlan(editor, selection.included, selection.excluded)
    : matchesEditorTags(editor, selection.included, selection.excluded, selection.match))
  return presorted ? matches : matches.sort(compareEditorsByFavorite)
}

/** Immutable selection; callers decide whether the scope is one row, one page, or all results. */
export function changeEditorSelection(selected: ReadonlySet<number>, scope: readonly Pick<Editor, 'id'>[], checked: boolean) {
  const next = new Set(selected)
  for (const editor of scope) { if (checked) next.add(editor.id); else next.delete(editor.id) }
  return next
}

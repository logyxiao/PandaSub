import { useCallback, useMemo } from 'react'
import type { Editor } from '../types'
import type { EditorTagSelection } from '../components/EditorTags'
import { buildEditorSearchIndex, searchEditorIndex, matchEditorResults, pickPlatformEditors } from '../lib/editorListModel'

export function useEditorListModel(items: readonly Editor[], {
  query = '', platform = '', source = '', favoritedOnly = false, predicate, plan = false,
  onePerPlatform = false, selectedIds,
}: { query?: string; platform?: string; source?: string; favoritedOnly?: boolean
  predicate?: (editor: Editor) => boolean; plan?: boolean; onePerPlatform?: boolean; selectedIds?: ReadonlySet<number> }) {
  const platforms = useMemo(() => [...new Set(items.map(editor => editor.platform.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh')), [items])
  const index = useMemo(() => buildEditorSearchIndex(items), [items])
  const basePool = useMemo(() => searchEditorIndex(index, query, platform), [index, query, platform])
  const candidates = useMemo(() => basePool.filter(editor => (!source || editor.source === source)
    && (!favoritedOnly || editor.favorited) && (!predicate || predicate(editor))), [basePool, source, favoritedOnly, predicate])
  const matchingEditors = useCallback((selection: EditorTagSelection) => {
    const matches = matchEditorResults(candidates, selection, plan, true)
    return onePerPlatform && !query.trim() ? pickPlatformEditors(matches, selectedIds) : matches
  }, [candidates, plan, onePerPlatform, query, selectedIds])
  return { platforms, basePool, candidates, matchingEditors }
}

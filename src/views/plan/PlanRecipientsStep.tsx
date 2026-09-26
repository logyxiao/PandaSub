import { ArrowLeft, ArrowRight, Check, CheckCheck, FolderOpen, Heart, HeartOff, Pencil, Plus, Square, Users } from 'lucide-react'
import { Button, EmptyState } from '../../components/ui'
import { EditorsList } from '../Editors'
import {
  mergeEditorSelectionByPlatform,
  summarizeEditorGroup
} from '../planShared'
import type { PlanEditorModel } from './usePlanEditor'
export function PlanRecipientsStep({ model }: { model: PlanEditorModel }) {
  const {
    editorPickMode, openNewGroup, openAddEditor, setEditorPickMode, groupPlanIds, selectedIds,
    selectedGroupId, groupPicks, activeSelectedIds, recipients, listCount, toggleEditorGroup,
    openEditGroup, openPlanMembers, savePlanAsGroup, selectedEditors, editors, toggleSelect,
    setListCount, setVisibleEditors, platformPeersOf, replacePlatformEditor, onFavoriteChange, openEditEditor,
    listFilters, setListFilters, setSelectedIds, visibleEditors, allResultsSelected, selectEditorResults,
    selectedResultPlatforms, deselectEditorResults, favoriteEditors, hasSelectedFavorite, orphans, sendCount,
    setStep, goToStep3,
  } = model
  return ((
    <section className="plan-step-2">
      <div className="plan-work-card plan-recipient-workspace">
        <div className="plan-recipient-heading">
          <div className="plan-content-heading">
            <span className="plan-content-icon"><Users size={20} strokeWidth={1.7} /></span>
            <div><h3>选择收稿编辑</h3><p>使用常投名单，或从编辑库挑选这次的收稿人。</p></div>
          </div>
          {editorPickMode === 'groups'
            ? <Button size="sm" onClick={openNewGroup}><Plus size={14} />新建编辑组</Button>
            : <Button size="sm" onClick={openAddEditor}><Plus size={14} />添加编辑</Button>}
        </div>
        <div className="plan-editor-pick-nav">
          <div className="plan-editor-pick-tabs" role="tablist" aria-label="选择编辑方式">
            <button type="button" role="tab" aria-selected={editorPickMode === 'groups'}
              className={editorPickMode === 'groups' ? 'on' : ''} onClick={() => setEditorPickMode('groups')}>
              <FolderOpen size={14} />编辑组<small>{groupPlanIds.size}</small>
            </button>
            <button type="button" role="tab" aria-selected={editorPickMode === 'all'}
              className={editorPickMode === 'all' ? 'on' : ''} onClick={() => setEditorPickMode('all')}>
              <Users size={14} />全部编辑<small>{selectedIds.size}</small>
            </button>
          </div>
          <span className="step-meta">
            {editorPickMode === 'groups'
              ? selectedGroupId
                ? <>已选「{groupPicks.find((pick) => pick.group.id === selectedGroupId)?.group.name}」<strong>{activeSelectedIds.size}</strong> 位，将投出 <strong>{recipients.length}</strong> 封</>
                : <>共 <strong>{groupPicks.length}</strong> 个编辑组，点选一组即可用于这次投稿</>
              : <>共有 <strong>{listCount ?? 0}</strong> 条可选数据，当前选择 <strong>{selectedIds.size}</strong> 位编辑</>}
          </span>
        </div>
        {editorPickMode === 'groups' ? (
          groupPicks.length ? (
            <div className="plan-group-board">
              <div className="plan-group-cards" role="radiogroup" aria-label="选择编辑组">
                {groupPicks.map(({ group, members }) => {
                  const selected = selectedGroupId === group.id
                  const summary = summarizeEditorGroup(members)
                  return (
                    <div key={group.id} className={`plan-group-card ${selected ? 'on' : ''} ${!members.length ? 'is-empty' : ''}`}>
                      <button type="button" role="radio" aria-checked={selected}
                        className="plan-group-card-main" disabled={!members.length}
                        onClick={() => toggleEditorGroup(group.id)}>
                        <span className="plan-group-choice-check">{selected && <Check size={13} />}</span>
                        <span className="plan-group-card-copy">
                          <b>{group.name}</b>
                          <small>{summary.platformsLabel} · {summary.count} 位</small>
                        </span>
                      </button>
                      <button type="button" className="plan-group-card-edit" title="管理成员"
                        onClick={() => openEditGroup(group)}>
                        <Pencil size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
              {selectedGroupId ? (
                <div className="plan-group-roster">
                  <div className="plan-group-roster-head">
                    <div>
                      <b>这次将投给 {groupPlanIds.size} 位</b>
                      <p>有效邮箱 {recipients.length} 个。临时增减只影响这次，不会改原组。</p>
                    </div>
                    <Button size="sm" onClick={openPlanMembers}>调整名单</Button>
                    <Button size="sm" variant="ghost" disabled={!groupPlanIds.size} onClick={savePlanAsGroup}>存成新组</Button>
                  </div>
                  {selectedEditors.length ? (
                    <ul className="plan-group-faces">
                      {selectedEditors.slice(0, 14).map((editor) => (
                        <li key={editor.id} title={`${editor.name.trim() || '佚名'} · ${editor.email}`}>
                          <b>{editor.name.trim() || '佚名'}</b>
                          <small>{editor.platform.trim() || '未填平台'}</small>
                        </li>
                      ))}
                      {selectedEditors.length > 14 && (
                        <li className="plan-group-faces-more">+{selectedEditors.length - 14}</li>
                      )}
                    </ul>
                  ) : (
                    <p className="hint">名单是空的，点「调整名单」加人。</p>
                  )}
                </div>
              ) : (
                <p className="plan-group-choice-hint">点选一个组，名单会复制到这次计划。之后临时加减人不会改原组。</p>
              )}
            </div>
          ) : (
            <div className="panel">
              <EmptyState icon={FolderOpen} title="还没有编辑组" desc="先把常投的人收成一组，之后投稿时点一下就能选入。"
                action={<Button size="sm" variant="primary" onClick={openNewGroup}><Plus size={13} />新建编辑组</Button>} />
            </div>
          )
        ) : (
          <EditorsList
            items={editors}
            selectable
            onePerPlatform
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onTotalChange={setListCount}
            onVisibleChange={setVisibleEditors}
            platformPeersOf={platformPeersOf}
            onReplaceEditor={replacePlatformEditor}
            onFavoriteChange={onFavoriteChange}
            onEdit={openEditEditor}
            filters={listFilters}
            onFiltersChange={(next) => {
              const tagsChanged = next.workTypes.join('\0') !== listFilters.workTypes.join('\0')
                || next.excludedWorkTypes.join('\0') !== listFilters.excludedWorkTypes.join('\0')
              setListFilters(next)
              if (tagsChanged) {
                setSelectedIds((prev) => mergeEditorSelectionByPlatform(
                  editors, prev, next.workTypes, next.excludedWorkTypes,
                ))
              }
            }}
            pageSize={6}
            actions={
              <>
                <div className="plan-bulk-actions" role="group" aria-label="批量选择当前筛选结果">
                  <span>筛选结果</span>
                  <Button size="sm" disabled={!visibleEditors.length || allResultsSelected}
                    title="选中所有分页的筛选结果，每个平台保留一位编辑"
                    onClick={() => selectEditorResults(visibleEditors)}>
                    <CheckCheck size={13} />全选
                  </Button>
                  <Button size="sm" disabled={!selectedResultPlatforms.size}
                    title="取消所有分页筛选结果的勾选，保留筛选范围外的选择"
                    onClick={() => deselectEditorResults(visibleEditors)}>
                    <Square size={13} />取消全选
                  </Button>
                </div>
                <Button size="sm" className="favorite-action" disabled={!favoriteEditors.length}
                  onClick={() => selectEditorResults(favoriteEditors)}>
                  <Heart size={12} />选择收藏编辑
                </Button>
                <Button size="sm" className="favorite-action is-remove" disabled={!hasSelectedFavorite}
                  onClick={() => deselectEditorResults(favoriteEditors)}>
                  <HeartOff size={12} />取消选择收藏编辑
                </Button>
              </>
            }
            emptyText="没有符合筛选的编辑。可调整筛选，或点右上角从编辑库添加。"
          />
        )}
        {editorPickMode === 'all' && !!orphans.length && (
          <p className="step-orphan">另有 {orphans.length} 位保存过的收件人不在编辑库中，将保留发送。</p>
        )}
      </div>
      <div className="step-actions plan-content-actions">
        <span><Users size={15} />已选 {activeSelectedIds.size + (editorPickMode === 'all' ? orphans.length : 0)} 位编辑 · {sendCount} 个有效收稿邮箱</span>
        <div className="plan-footer-buttons">
          <Button onClick={() => setStep(1)}><ArrowLeft size={15} />上一步</Button>
          <Button variant="primary" onClick={goToStep3}>下一步：选择邮箱<ArrowRight size={16} /></Button>
        </div>
      </div>
    </section>
  ))
}

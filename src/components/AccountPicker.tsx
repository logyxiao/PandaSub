import type { Account } from '../types'
import { providerName } from '../format'
import { accountTodayQuota } from '../views/planShared'

export function AccountPicker({ accounts, selectedIds, onToggle, emptyMeansAll = true }: {
  accounts: Account[]; selectedIds: number[]; onToggle: (id: number) => void; emptyMeansAll?: boolean
}) {
  return <div className="account-pick-list">
    {accounts.map(account => {
      const selected = (emptyMeansAll && !selectedIds.length) || selectedIds.includes(account.id)
      const quota = accountTodayQuota(account.sent_today)
      return <label key={account.id} className={`account-pick-row ${selected ? 'on' : ''} ${quota.over ? 'is-over' : ''}`}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(account.id)} aria-label={`${selected ? '取消选择' : '选择'} ${account.email}`} />
        <span className="account-pick-main"><b>{account.email}</b><small>{account.sender_name || '未设笔名'} · {providerName[account.provider] ?? account.provider} · 今日 {quota.label}</small>
          {quota.over && <small className="account-quota-warn">已达建议 80 封，建议不要再用这封发送</small>}
        </span>
      </label>
    })}
    {!accounts.length && <p className="account-pick-empty">还没有启用邮箱，去「邮箱」页添加并启用后再来。</p>}
  </div>
}

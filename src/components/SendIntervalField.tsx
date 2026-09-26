import { isValidSendIntervalRange, MAX_SEND_INTERVAL_SEC } from '../views/planShared'

export function SendIntervalField({ fromSec, toSec, touched, onBlur, onChange }: {
  fromSec: number; toSec: number; touched: boolean
  onBlur: () => void
  onChange: (side: 'from' | 'to', value: number) => void
}) {
  const invalid = touched && !isValidSendIntervalRange(fromSec, toSec)
  return <div className="send-interval-range" aria-label="随机发送间隔">
    {(['from', 'to'] as const).map((side, index) => <div className="send-interval-part" key={side}>
      {index > 0 && <span className="send-interval-separator">至</span>}
      <label className="send-interval-field">
        <span>{side === 'from' ? '最短间隔' : '最长间隔'}</span>
        <span className="send-interval-input-wrap">
          <input type="number" min={1} max={MAX_SEND_INTERVAL_SEC} step={1} value={(side === 'from' ? fromSec : toSec) || ''}
            aria-invalid={invalid} onBlur={onBlur} onChange={event => onChange(side, event.target.value === '' ? 0 : Math.round(Number(event.target.value)))} />
          <em>秒</em>
        </span>
      </label>
    </div>)}
  </div>
}

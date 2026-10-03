import type { Editor } from '../types'

function duration(seconds: number) {
  if (seconds < 60) return '不足 1 分钟'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
  const days = Math.floor(hours / 24)
  return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`
}

export function EditorReplyTime({ editor }: { editor: Editor }) {
  const seconds = editor.average_reply_seconds
  const count = editor.reply_sample_count ?? 0
  const available = count > 0 && seconds != null && Number.isFinite(seconds) && seconds >= 0
  return <div className="editor-reply-time" title="按本机历史记录，每次成功发送至首次人工回复计算平均值；自动回复、退信、未回复及异常时间不计入。">
    <span>{available ? duration(seconds) : '暂无数据'}</span>
    <small>{available ? `基于 ${count} 次投递` : '暂无有效人工回复'}</small>
  </div>
}

import { useEffect } from 'react'
import { useConfirm, useToast } from './feedback'
import { availableUpdate, installUpdate, restartApp } from '../update'

const DISMISSED_KEY = 'novelsub.dismissed-update'

export function UpdateManager() {
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const update = await availableUpdate()
        if (cancelled || !update) return
        if (sessionStorage.getItem(DISMISSED_KEY) === update.version) {
          await update.close()
          return
        }

        const accepted = await confirm({
          title: `发现新版本 v${update.version}`,
          message: update.body?.trim() || '新版本已经可以下载。更新会保留本机邮箱、计划和发送记录。',
          confirmLabel: '下载并安装',
          cancelLabel: '稍后更新',
        })
        if (!accepted || cancelled) {
          sessionStorage.setItem(DISMISSED_KEY, update.version)
          await update.close()
          return
        }

        toast('正在下载更新，完成前请保持应用运行', 'info')
        await installUpdate(update)
        if (cancelled) return
        const restart = await confirm({
          title: '更新安装完成',
          message: '重启熊猫投稿后即可使用新版本。正在发送的计划会在重启时停止。',
          confirmLabel: '立即重启',
          cancelLabel: '稍后重启',
        })
        if (restart) await restartApp()
      } catch {
        // 启动检查不打扰用户；手动检查会在设置页显示具体错误。
      }
    }, 5000)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [confirm, toast])

  return null
}

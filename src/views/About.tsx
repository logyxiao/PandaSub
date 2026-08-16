import { useEffect, useState } from 'react'
import { Code2, ExternalLink, HardDrive, Shield } from 'lucide-react'
import { api } from '../api'
import logo from '../assets/logo.png'
import { SupportAuthor } from '../components/SupportAuthor'

const PROJECT_URL = 'https://github.com/logyxiao/PandaSub'

export function AboutView() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    api.checkUpdate().then((u) => setVersion(u.current)).catch(() => {})
  }, [])

  return (
    <div className="about-page">
      <section className="panel about-hero">
      <div>
      <img className="about-logo" src={logo} alt="" />
      <h2>熊猫投稿</h2>
      </div>
        <div>
          <section className="panel about-section">
        <div className="about-points">
          <article>
            <HardDrive size={18} />
            <div>
              <b>本地运行</b>
              <p>邮箱、编辑库、投稿计划和发送记录保存在本机 SQLite，关闭窗口后仍可在托盘继续发送。</p>
            </div>
          </article>
          <article>
            <Shield size={18} />
            <div>
              <b>邮箱安全</b>
              <p>QQ / 163 请使用 SMTP 授权码，不要填网页登录密码。授权码只用于本机发送和检查回复。</p>
            </div>
          </article>
          <article>
            <Code2 size={18} />
            <div>
              <b>完全开源免费</b>
              <p>
                代码托管在{' '}
                <a href={PROJECT_URL} target="_blank" rel="noreferrer">GitHub</a>
                ，可自由查看、使用和反馈问题。赞助自愿，不绑定任何功能。
              </p>
            </div>
          </article>
        </div>
      </section>
        </div>
      </section>

     

      <section className="panel about-section">
        <div className="panel-heading">
          <div>
            <h2>支持作者</h2>
            <p>如果工具帮到了你，扫码请作者喝杯咖啡。赞助自愿，软件始终完全免费。</p>
          </div>
        </div>
        <div className="pad">
          <SupportAuthor compact />
        </div>
      </section>
    </div>
  )
}

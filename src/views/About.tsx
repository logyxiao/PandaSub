import { useEffect, useState } from 'react'
import { Code2, ExternalLink, HardDrive, Shield } from 'lucide-react'
import logo from '../assets/logo.png'
import { SupportAuthor } from '../components/SupportAuthor'
import { currentVersion } from '../update'

const PROJECT_URL = 'https://github.com/logyxiao/NovelSub'

export function AboutView() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    currentVersion().then(setVersion).catch(() => {})
  }, [])

  return (
    <div className="about-page">
      <section className="panel about-hero">
        <img className="about-logo" src={logo} alt="" />
        <div>
          <h2>熊猫投稿</h2>
          <p>面向小说作者的本地桌面投稿工具。把发件邮箱、编辑资料、作品信息、投稿计划和回复检查放在一起，帮助你有节奏地完成投稿。</p>
          <p className="about-free">本项目<strong>完全开源免费</strong>，所有功能均可免费使用，不设付费墙。</p>
          <div className="about-meta">
            <span>版本 {version ? `v${version}` : '读取中…'}</span>
            <span>标识 com.novelsub.desktop</span>
            <span>数据仅保存在本机</span>
          </div>
          <a className="about-repo" href={PROJECT_URL} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {PROJECT_URL}
          </a>
        </div>
      </section>

      <section className="panel about-section">
        <div className="panel-heading">
          <div>
            <h2>项目说明</h2>
            <p>完全开源免费、本地优先，不上传你的稿件和邮箱授权码。</p>
          </div>
        </div>
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

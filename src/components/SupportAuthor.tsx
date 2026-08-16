import wechatQr from '../assets/donate/wechat.png'
import alipayQr from '../assets/donate/alipay.jpeg'

export function SupportAuthor({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`support-author ${compact ? 'is-compact' : ''}`.trim()}>
      {!compact && (
        <div className="support-author-copy">
          <h3>支持作者</h3>
          <p>熊猫投稿完全开源免费。如果帮到了你，欢迎请作者喝杯咖啡。赞助完全自愿，不影响任何功能。</p>
        </div>
      )}
      <div className="support-author-codes">
        <figure className="support-qr">
          <img src={wechatQr} alt="微信收款码" />
          <figcaption>微信</figcaption>
        </figure>
        <figure className="support-qr">
          <img src={alipayQr} alt="支付宝收款码" />
          <figcaption>支付宝</figcaption>
        </figure>
      </div>
      <p className="support-author-hint">用手机打开微信或支付宝扫码即可。金额随意，感谢支持。</p>
    </div>
  )
}

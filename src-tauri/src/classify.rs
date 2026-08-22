//! Classify an inbound mail as auto-reply, bounce, or human reply.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyKind {
    Auto,
    Human,
    Bounce,
}

impl ReplyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ReplyKind::Auto => "auto",
            ReplyKind::Human => "human",
            ReplyKind::Bounce => "bounce",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct IncomingMail {
    pub from: String,
    pub subject: String,
    pub body: String,
    pub content_type: String,
    pub extra_headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    pub kind: ReplyKind,
    pub reason: String,
}

pub fn classify(mail: &IncomingMail) -> Classification {
    let from = mail.from.to_lowercase();
    let subject = mail.subject.to_lowercase();
    let body = unique_body(&mail.body);
    let body_l = body.to_lowercase();
    let content_type = mail.content_type.to_lowercase();
    let headers = mail
        .extra_headers
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.to_lowercase()))
        .collect::<Vec<_>>();

    // 退信优先识别（投递失败通知），其余邮件只看主题：
    // 主题包含「自动回复 / 自動回覆 / AutoReply」即判自动回复，否则一律按人工回复。
    if is_bounce(&from, &subject, &body_l, &content_type, &headers) {
        return Classification {
            kind: ReplyKind::Bounce,
            reason: "退信或投递失败通知".into(),
        };
    }

    if let Some(reason) = auto_reply_reason(&subject) {
        return Classification {
            kind: ReplyKind::Auto,
            reason: reason.into(),
        };
    }

    Classification {
        kind: ReplyKind::Human,
        reason: "主题不含自动回复标记，按人工回复处理".into(),
    }
}

fn auto_reply_reason(subject: &str) -> Option<&'static str> {
    if subject.contains("自动回复") || subject.contains("自動回覆") {
        return Some("主题包含「自动回复」，判定为自动回复");
    }
    if subject.contains("autoreply") || subject.contains("auto-reply") {
        return Some("主题包含 AutoReply，判定为自动回复");
    }
    None
}

/// 人工回复正文是否包含「过稿」信号：审核通过、初审、过稿、录用等。
/// 先排除「未通过 / 没过」等否定表达，避免「初审未通过」被误判。
pub fn body_suggests_accepted(body: &str) -> bool {
    let body = body.to_lowercase();
    if body.contains("未通过")
        || body.contains("没有通过")
        || body.contains("未过")
        || body.contains("没过")
    {
        return false;
    }
    const KEYS: &[&str] = &[
        "审核通过",
        "过稿",
        "初审",
        "复审通过",
        "终审通过",
        "三审通过",
        "录用",
        "采用",
        "签约通过",
    ];
    KEYS.iter().any(|k| body.contains(k))
}

fn header_present(headers: &[(String, String)], name: &str) -> bool {
    headers
        .iter()
        .any(|(k, v)| k == name && v != "no" && !v.is_empty())
}

fn is_bounce(
    from: &str,
    subject: &str,
    body: &str,
    content_type: &str,
    headers: &[(String, String)],
) -> bool {
    if content_type.contains("multipart/report") || content_type.contains("delivery-status") {
        return true;
    }
    if header_present(headers, "x-failed-recipients") {
        return true;
    }
    if from.contains("mailer-daemon") || from.contains("postmaster") {
        return true;
    }
    const SUBJ: &[&str] = &[
        "undeliverable",
        "undelivered",
        "delivery status",
        "delivery failure",
        "returned mail",
        "mail delivery failed",
        "failure notice",
        "无法投递",
        "投递失败",
        "退信",
        "退回",
        "地址不存在",
    ];
    SUBJ.iter().any(|k| subject.contains(k)) || body.contains("diagnostic-code")
}

fn unique_body(body: &str) -> String {
    let mut lines = Vec::new();
    for line in body.lines() {
        let t = line.trim();
        if t.starts_with('>') {
            continue;
        }
        if t.starts_with("On ") && t.contains("wrote") {
            break;
        }
        if t.contains("原始邮件") || t.contains("Original Message") || t.contains("转发的邮件")
        {
            break;
        }
        if t.starts_with("-----") {
            break;
        }
        if t.starts_with("在 ") && (t.contains("写道") || t.contains("寫道")) {
            break;
        }
        lines.push(t);
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(from: &str, subject: &str, body: &str) -> IncomingMail {
        IncomingMail {
            from: from.into(),
            subject: subject.into(),
            body: body.into(),
            ..IncomingMail::default()
        }
    }

    #[test]
    fn auto_subject_is_auto() {
        let m = mail(
            "noreply@site.com",
            "自动回复：已收到投稿",
            "请勿回复此邮件，这是系统自动发送的。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Auto);
    }

    #[test]
    fn traditional_chinese_auto_subject_is_auto() {
        let m = mail(
            "noreply@site.com",
            "自動回覆：稿件收到",
            "系統自動發送，請勿回覆。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Auto);
    }

    #[test]
    fn english_autoreply_subject_is_auto() {
        let m = mail(
            "noreply@site.com",
            "AutoReply: 稿件已收到",
            "This is an automatic reply.",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Auto);
        let m = mail(
            "noreply@site.com",
            "Re: Auto-Reply 已收到您的来信",
            "请勿回复。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Auto);
    }

    #[test]
    fn no_auto_keyword_is_human() {
        // 简化后的规则只看主题：即使正文/邮件头有自动特征，主题不含「自动回复」也判人工。
        let m = mail(
            "noreply@site.com",
            "Re: 投石穿云",
            "请勿回复此邮件，这是系统自动发送的。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Human);
    }

    #[test]
    fn editorial_human() {
        let m = mail(
            "zhangsan@qidian.com",
            "Re: 投石穿云",
            "您好，责编看过第一章，建议修改开篇节奏，进入二审前请先按意见改一版。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Human);
    }

    #[test]
    fn bounce_mailer_daemon() {
        let m = mail(
            "MAILER-DAEMON@qq.com",
            "Undelivered Mail Returned to Sender",
            "Diagnostic-Code: smtp; 550",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Bounce);
    }

    #[test]
    fn receipt_without_auto_subject_is_human() {
        // 主题没有「自动回复」的系统确认信按新规则也判人工。
        let m = mail(
            "tougao@web.com",
            "投稿确认",
            "感谢您的投稿，稿件已进入审核队列。此邮件由系统发出，请勿回复。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Human);
    }

    #[test]
    fn short_plain_reply_is_human() {
        let m = mail(
            "editor@site.com",
            "Re: 投石穿云",
            "方便今晚十点通话吗？我是责编李四。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Human);
    }

    #[test]
    fn short_received_confirmation_is_human() {
        let m = mail(
            "editor@site.com",
            "Re: 投石穿云",
            "稿件已收到，我们一周内会给结果。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Human);
    }

    #[test]
    fn editorial_promise_is_human() {
        let m = mail(
            "editor@site.com",
            "Re: 投石穿云",
            "稿子看到了，我会尽快回复审稿意见。",
        );
        assert_eq!(classify(&m).kind, ReplyKind::Human);
    }

    #[test]
    fn accepted_keywords_detected() {
        for text in [
            "审核通过，请签约",
            "恭喜过稿！",
            "稿件初审通过",
            "复审通过，进入终审",
            "您的作品被录用",
        ] {
            assert!(body_suggests_accepted(text), "应识别为过稿: {text}");
        }
    }

    #[test]
    fn rejected_phrases_not_detected() {
        for text in ["初审未通过", "审核没有通过", "稿件没过", "尚未通过审核"]
        {
            assert!(!body_suggests_accepted(text), "不应识别为过稿: {text}");
        }
    }
}

"""Inbox navigation, persisted read state, and rule editing using isolated fixtures."""
import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
accounts[0].email='writer@qq.com';
accounts.push({...accounts[0],id:2,email:'writer@163.com',enabled:false});
accounts.push({...accounts[0],id:3,email:'empty@qq.com'});
replies.forEach((reply,i)=>{reply.account_id=i%2?2:1});
replies[1].body=Array.from({length:12},(_,i)=>`第${i+1}段：已收到您的稿件，请补充人物关系、情节提纲与作品字数。`).join('\n\n');
window.__fixtureReplies=replies;
const syncFlags=functions.syncReplyReadFlags;
functions.syncReplyReadFlags=(ids)=>window.__failFlagSync?Promise.reject(new Error('fixture IMAP offline')):syncFlags(ids);
const queryReplies=functions.listRepliesPage;
functions.listRepliesPage=(...args)=>{
 const result=queryReplies(...args);
 if(window.__deferInbox){window.__deferInbox=false;return new Promise(resolve=>window.__finishInbox=()=>resolve(result))}
 return result;
};
'''
artifacts=Path(tempfile.mkdtemp(prefix='novelsub-inbox-'))
with sync_playwright() as p:
    browser=getattr(p,os.environ.get('NOVELSUB_TEST_BROWSER','webkit')).launch()
    page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    page.wait_for_load_state('networkidle')
    nav=page.get_by_role('navigation',name='主导航')
    # A dashboard link opens the mail preview immediately and marks it read.
    page.locator('.dashboard-reply-list > button').first.click()
    expect(page.locator('.page-heading h1')).to_have_text('收件箱')
    preview=page.get_by_role('dialog',name='邮件阅读',exact=True)
    expect(preview).to_contain_text('writer@qq.com')
    expect(page.locator('.reply-list-item').first).to_have_class('reply-list-item is-read')
    page.keyboard.press('Escape')
    expect(preview).to_have_count(0)
    group=page.get_by_role('group',name='收件箱账号')
    expect(group.get_by_role('button',name='全部账号',exact=True)).to_have_attribute('aria-pressed','true')
    expect(group.get_by_role('button',name='writer@163.com',exact=True)).to_be_visible()
    expect(page.locator('.pager-meta')).to_contain_text('共 305 条')
    def account(label):
        group.get_by_role('button',name=label,exact=True).click()
    page.screenshot(path=str(artifacts/'inbox-list.png'))
    expect(page.locator('.reply-list-item').nth(2)).to_have_class('reply-list-item is-read')
    already_read=page.locator('.reply-list-item.is-read').count()
    unread=page.locator('.reply-list-item.is-unread').first
    unread.click()
    preview=page.get_by_role('dialog')
    page.screenshot(path=str(artifacts/'inbox-preview.png'))
    box=preview.bounding_box()
    assert box['y']>=0 and box['y']+box['height']<=900
    assert preview.locator('.modal-body').evaluate('e=>e.scrollHeight>e.clientHeight')
    expect(preview.get_by_role('button',name='标为未读',exact=True)).to_be_visible()
    reply_id=page.evaluate("window.__calls.filter(c=>c.name==='setReplyRead').at(-1).args[0]")
    expect(page.locator('.reply-list-item.is-read')).to_have_count(already_read+1)
    preview.get_by_role('button',name='标为未读',exact=True).click()
    expect(preview).to_have_count(0)
    assert page.evaluate('window.__calls.filter(c=>c.name===\'setReplyRead\').at(-1).args')==[reply_id,False]
    expect(page.locator('.reply-list-item.is-read')).to_have_count(already_read)
    page.evaluate('window.__failSeenStore=true')
    page.locator('.reply-list-item.is-unread').first.click()
    expect(page.locator('.toasts')).to_contain_text('fixture IMAP STORE rejected')
    expect(page.locator('.reply-list-item.is-unread').first).to_be_visible()
    page.keyboard.press('Escape')
    page.evaluate('window.__failSeenStore=false')
    page.get_by_role('button',name='16',exact=True).click()
    expect(page.locator('.reply-list-item')).to_have_count(5)
    account('writer@163.com')
    expect(page.locator('.pager-meta')).to_contain_text('共 152 条')
    expect(page.locator('.pager-meta')).to_contain_text('第 1–20 条')
    assert all('writer@163.com' in text for text in page.locator('.reply-list-account').all_text_contents())
    expect(page.get_by_role('dialog')).to_have_count(0)
    account('writer@qq.com')
    expect(page.locator('.pager-meta')).to_contain_text('共 153 条')
    search=page.get_by_placeholder('搜索邮件、编辑或邮箱')
    search.fill('最早')
    expect(page.locator('.pager-meta')).to_contain_text('共 1 条')
    account('writer@163.com')
    expect(page.locator('.reply-list-item')).to_have_count(0)
    search.fill('')
    expect(page.locator('.pager-meta')).to_contain_text('共 152 条')
    page.evaluate('window.__deferInbox=true')
    account('writer@qq.com')
    page.wait_for_function("typeof window.__finishInbox==='function'")
    account('writer@163.com')
    expect(page.locator('.pager-meta')).to_contain_text('共 152 条')
    page.evaluate('window.__finishInbox()')
    expect(page.locator('.pager-meta')).to_contain_text('共 152 条')
    account('empty@qq.com')
    expect(page.locator('.reply-list-item')).to_have_count(0)
    account('全部账号')
    expect(page.locator('.pager-meta')).to_contain_text('共 305 条')
    # An IMAP failure leaves old mail neutral instead of guessing unread.
    page.evaluate('window.__failFlagSync=true;window.__fixtureReplies[3].read_synced=false')
    page.get_by_role('button',name='刷新列表',exact=True).click()
    unknown=page.locator('.reply-list-item').filter(has_text='回复302')
    expect(unknown).to_have_class('reply-list-item is-unverified')
    expect(page.locator('.reply-list-caption')).to_contain_text('状态待同步')
    page.evaluate('window.__failFlagSync=false')
    page.get_by_role('button',name='刷新列表',exact=True).click()
    expect(unknown).to_have_class('reply-list-item is-unread')
    # Read state survives leaving and returning to the inbox.
    nav.get_by_role('button',name='工作台',exact=True).click()
    nav.get_by_role('button',name='收件箱',exact=True).click()
    expect(page.locator('.reply-list-item').first).to_have_class('reply-list-item is-read')
    expect(page.get_by_role('dialog')).to_have_count(0)
    # Rules remain directly editable here, not on the Settings page.
    page.get_by_role('button',name='编辑关键词',exact=True).click()
    rules=page.get_by_role('dialog',name='自动回复识别关键词',exact=True)
    field=rules.get_by_role('textbox',name='自动回复主题关键词')
    field.fill('系统回执\nReceipt\nreceipt')
    rules.get_by_role('button',name='保存规则',exact=True).click()
    expect(page.locator('.inbox-rule-keywords > span')).to_have_count(2)
    assert page.evaluate('window.__settings.auto_reply_subject_keywords')==['系统回执','Receipt']
    page.get_by_role('button',name='编辑关键词',exact=True).click()
    field.fill('')
    rules.get_by_role('button',name='保存规则',exact=True).click()
    expect(page.locator('.inbox-rule-empty')).to_have_text('未设置关键词')
    page.screenshot(path=str(artifacts/'inbox-rules.png'))
    page.set_viewport_size({'width':720,'height':560})
    expect(page.get_by_role('button',name='按账号筛选',exact=True)).to_be_visible()
    page.get_by_role('button',name='按账号筛选',exact=True).click()
    page.get_by_role('option',name='writer@163.com',exact=True).click()
    expect(page.locator('.pager-meta')).to_contain_text('共 152 条')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert not errors,errors
    browser.close()
print('PASS: sidebar accounts, full-width list, persistent unread state, modal preview, account filtering, rule editing, and narrow layout')
print('Screenshots:',artifacts)

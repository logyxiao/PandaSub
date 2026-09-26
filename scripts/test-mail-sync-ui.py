"""Ordinary inbox mail, submission filters and live account status; mock-only network."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base={...replies[0],read_synced:true,is_read:false};
replies.splice(0,replies.length,
 {...base,id:1,subject:'普通测试邮件',kind:'human',delivery_id:null,task_id:null,task_name:'',recipient:''},
 {...base,id:2,subject:'投稿人工回复',kind:'human'},
 {...base,id:3,subject:'自动回复：测试',kind:'auto',is_read:true,delivery_id:null,task_id:null});
replies.forEach(reply=>serverSeen.set(reply.id,reply.is_read));
functions.getInboxStatus=()=>[{account_id:1,mode:'idle',detail:'实时监听中',last_sync:'2026-09-26 12:00:00'}];
window.__newMail=()=>{
 const mail={...replies[0],id:4,subject:'实时到达测试',is_read:false};
 replies.unshift(mail);serverSeen.set(mail.id,false);window.__emit('reply',mail);
};
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':800})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    nav=page.get_by_role('navigation',name='主导航')
    inbox=nav.get_by_role('button',name='收件箱',exact=True)
    expect(inbox.locator('.nav-unread-badge')).to_have_text('2')
    inbox.click()
    status=page.get_by_role('status',name='收件同步状态')
    expect(status).to_contain_text('fixture@example.com · 实时监听')
    rows=page.locator('.reply-list-item')
    expect(rows).to_have_count(3)
    expect(rows.filter(has_text='普通测试邮件')).to_contain_text('普通来信')
    rows.filter(has_text='普通测试邮件').click()
    preview=page.get_by_role('dialog',name='邮件阅读')
    expect(preview).to_contain_text('普通来信，不计入投稿统计')
    expect(inbox.locator('.nav-unread-badge')).to_have_text('1')
    preview.get_by_role('button',name='完成',exact=True).click()
    kind=page.get_by_role('button',name='按类型筛选',exact=True)
    kind.click();page.get_by_role('option',name='普通来信',exact=True).click()
    expect(rows).to_have_count(2)
    expect(rows.filter(has_text='投稿人工回复')).to_have_count(0)
    page.evaluate('window.__newMail()')
    expect(rows).to_have_count(3)
    expect(rows.filter(has_text='实时到达测试')).to_be_visible()
    expect(inbox.locator('.nav-unread-badge')).to_have_text('2')
    kind.click();page.get_by_role('option',name='投稿相关',exact=True).click()
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text('投稿人工回复')
    page.evaluate("window.__emit('inbox-status',[{account_id:1,mode:'retrying',detail:'网络暂时不可用',last_sync:null}])")
    expect(status).to_contain_text('连接重试')
    expect(status.locator('.inbox-sync-account')).to_have_attribute('title','网络暂时不可用')
    page.evaluate("window.__emit('inbox-status',[{account_id:1,mode:'polling',detail:'定时检查',last_sync:null}])")
    expect(status).to_contain_text('定时检查')
    assert page.evaluate('document.documentElement.scrollHeight <= window.innerHeight'), 'Unexpected page scrollbar'
    page.screenshot(path='/tmp/novelsub-mail-sync.png')
    assert not errors,errors
    print('PASS: ordinary mail unread count, automatic exclusion, submission filters, event-driven arrival, read action, live connection status, compact default height')
    browser.close()

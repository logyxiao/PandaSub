"""Tray intent bridge with mocked native events and actual unread-list navigation."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base={...replies[0],read_synced:true,is_read:false,account_id:1};
replies.splice(0,replies.length,
 {...base,id:1,subject:'人工未读甲',kind:'human'},
 {...base,id:2,subject:'人工未读乙',kind:'human'},
 {...base,id:3,subject:'自动回执',kind:'auto',is_read:true},
 {...base,id:4,subject:'已读人工',kind:'human',is_read:true},
 {...base,id:5,subject:'未确认状态',kind:'human',read_synced:false},
 {...base,id:6,subject:'退信',kind:'bounce'});
replies.forEach(reply=>serverSeen.set(reply.id,reply.is_read));
window.__trayOpen=()=>{window.__trayRequest=true;window.__emit('open-unread-inbox',null);window.dispatchEvent(new Event('focus'))};
window.__trayRequest=true;
window.__autoPreview=[];
functions.listAcceptedWorks=()=>[];functions.listAcceptedCandidates=()=>[];
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    nav=page.get_by_role('navigation',name='主导航')
    rows=page.locator('.reply-list-item')
    # Native click before React was ready survives startup, including StrictMode effects.
    expect(page.locator('.page-heading h1')).to_have_text('收件箱')
    expect(page.get_by_role('button',name='按类型筛选',exact=True)).to_have_text('未读人工回复')
    expect(rows).to_have_count(2)
    expect(rows).not_to_contain_text(['自动回执','已读人工'])
    assert not page.evaluate("window.__calls.some(c=>c.name==='setReplyRead')")
    # Returning from elsewhere clears old filters and displays all-account unread messages.
    page.get_by_placeholder('搜索邮件、编辑或邮箱').fill('不匹配')
    expect(rows).to_have_count(0)
    page.evaluate('window.__trayOpen()')
    expect(page.get_by_placeholder('搜索邮件、编辑或邮箱')).to_have_value('')
    expect(rows).to_have_count(2)
    page.screenshot(path='/tmp/novelsub-tray-unread-list.png')
    # Reading while filtered removes the record and updates the empty state after the last one.
    rows.filter(has_text='人工未读甲').click()
    dialog=page.get_by_role('dialog',name='邮件阅读')
    expect(dialog).to_be_visible()
    expect(rows).to_have_count(1)
    dialog.get_by_role('button',name='完成',exact=True).click()
    rows.filter(has_text='人工未读乙').click()
    expect(rows).to_have_count(0)
    dialog.get_by_role('button',name='完成',exact=True).click()
    expect(page.get_by_text('暂无未读人工回复。',exact=True)).to_be_visible()
    expect(page.locator('.nav-unread-badge')).to_have_count(0)
    # Native navigation respects an unsaved form instead of silently discarding it.
    nav.get_by_role('button',name='过稿统计',exact=True).click()
    page.get_by_role('button',name='新增外部文章',exact=True).first.click()
    form=page.get_by_role('dialog',name='核对作品结果')
    form.get_by_label('作品名称').fill('不要丢失的草稿')
    page.evaluate('window.__trayOpen()')
    confirm=page.get_by_role('alertdialog')
    expect(confirm).to_be_visible()
    confirm.get_by_role('button',name='继续编辑',exact=True).click()
    expect(form.get_by_label('作品名称')).to_have_value('不要丢失的草稿')
    page.evaluate('window.__trayOpen()')
    expect(confirm).to_be_visible()
    confirm.get_by_role('button',name='放弃修改',exact=True).click()
    expect(page.locator('.page-heading h1')).to_have_text('收件箱')
    expect(page.get_by_role('button',name='按类型筛选',exact=True)).to_have_text('未读人工回复')
    assert not errors,errors
    print('PASS: queued native startup intent, event/focus coalescing, repeated unread navigation resets filters, filtered read removal and empty state, unsaved draft protection')
    browser.close()

"""Unread human badge and automatic-reply policy, with mock-only IMAP writes."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base={...replies[0],read_synced:true,is_read:false,received_at:'2026-09-26 12:00:00'};
replies.splice(0,replies.length,
 {...base,id:1,subject:'人工来信甲',kind:'human',account_id:1},
 {...base,id:2,subject:'人工来信乙',kind:'human',account_id:2},
 {...base,id:3,subject:'自动回执',kind:'auto',is_read:true},
 {...base,id:4,subject:'退信',kind:'bounce'},
 {...base,id:5,subject:'已读人工',kind:'human',is_read:true});
window.__fixtureReplies=replies;
replies.forEach(r=>serverSeen.set(r.id,r.is_read));
accounts.push({...accounts[0],id:2,email:'second@example.com'});
const sync=functions.syncReplyReadFlags;
functions.syncReplyReadFlags=ids=>({errors:[],states:sync(ids).states.map(state=>{
 const reply=replies.find(r=>r.id===state.id);
 if(reply.kind==='auto'){reply.is_read=true;return {...state,is_read:true}}return state;
})});
const count=functions.unreadHumanReplyCount;
functions.unreadHumanReplyCount=async()=>{
 if(window.__failCount)throw new Error('count offline');
 const value=count();if(window.__slowCount){window.__slowCount=false;await new Promise(resolve=>window.__finishCount=resolve)}
 return value;
};
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
    inbox=nav.get_by_role('button',name='收件箱',exact=True)
    badge=inbox.locator('.nav-unread-badge')
    expect(badge).to_have_text('2')
    expect(inbox).to_have_attribute('title','收件箱 · 2 封未读人工回复')
    page.screenshot(path='/tmp/novelsub-unread-badge.png')
    # Automatic/bounce replies do not change the count, including on another page.
    page.evaluate("window.__fixtureReplies.push({...window.__fixtureReplies[2],id:6});window.__emit('reply',window.__fixtureReplies.at(-1))")
    expect(badge).to_have_text('2')
    page.get_by_role('button',name='收起侧栏',exact=True).click()
    expect(badge).to_be_visible()
    expect(badge).to_have_css('width','7px')
    page.screenshot(path='/tmp/novelsub-unread-collapsed.png')
    page.get_by_role('button',name='展开侧栏',exact=True).click()
    inbox.click()
    rows=page.locator('.reply-list-item')
    expect(rows.filter(has_text='自动回执').first).to_have_class('reply-list-item is-read')
    expect(rows.filter(has_text='退信')).to_have_class('reply-list-item is-read')
    expect(rows.filter(has_text='自动回执').locator('.reply-unread-dot')).to_have_count(0)
    # Read toggles affect the cross-account count after successful persistence.
    rows.filter(has_text='人工来信甲').click()
    expect(badge).to_have_text('1')
    preview=page.get_by_role('dialog',name='邮件阅读')
    preview.get_by_role('button',name='标为未读',exact=True).click()
    expect(badge).to_have_text('2')
    page.evaluate('window.__failSeenStore=true')
    rows.filter(has_text='人工来信甲').click()
    expect(page.get_by_text('Error: fixture IMAP STORE rejected',exact=True)).to_be_visible()
    expect(badge).to_have_text('2')
    preview.get_by_role('button',name='完成',exact=True).click()
    page.evaluate('window.__failSeenStore=false')
    rows.filter(has_text='自动回执').first.click()
    expect(preview).to_contain_text('自动回复已默认阅读')
    expect(preview.get_by_role('button',name='标为未读',exact=True)).to_have_count(0)
    assert not page.evaluate("window.__calls.some(c=>c.name==='setReplyRead'&&[3,6].includes(c.args[0]))")
    preview.get_by_role('button',name='完成',exact=True).click()
    rows.filter(has_text='人工来信甲').click();expect(badge).to_have_text('1')
    preview.get_by_role('button',name='完成',exact=True).click()
    rows.filter(has_text='人工来信乙').click();expect(badge).to_have_count(0)
    preview.get_by_role('button',name='完成',exact=True).click()
    nav.get_by_role('button',name='工作台',exact=True).click()
    # An event received during a count request triggers a trailing refresh, not a stale final count.
    page.evaluate("window.__slowCount=true;window.__emit('reply-read-change')")
    page.wait_for_function("typeof window.__finishCount==='function'")
    page.evaluate("for(let i=10;i<115;i++)window.__fixtureReplies.push({...window.__fixtureReplies[0],id:i,is_read:false,read_synced:true});window.__emit('reply',window.__fixtureReplies.at(-1))")
    page.evaluate('window.__finishCount()')
    expect(badge).to_have_text('99+')
    expect(inbox).to_have_attribute('title','收件箱 · 105 封未读人工回复')
    page.evaluate("window.__failCount=true;window.__emit('reply-read-change')")
    expect(badge).to_have_text('99+')
    page.set_viewport_size({'width':720,'height':560})
    expect(badge).to_have_css('width','7px')
    assert not errors,errors
    print('PASS: human-only cross-account count, collapsed/narrow dot, automatic/bounce exclusion, successful and failed read writes, mark unread, zero hiding, 99+ display, stale-query coalescing')
    browser.close()

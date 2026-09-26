"""Delayed inbox reads must not reverse a completed user action or reopen a closed deep link."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
replies.splice(1);replies[0].is_read=false;replies[0].read_synced=true;serverSeen.set(replies[0].id,false);
const list=functions.listRepliesPage;
functions.listRepliesPage=(...args)=>{
 const snapshot=JSON.parse(JSON.stringify(list(...args)));
 if(window.__deferList){window.__deferList=false;return new Promise(resolve=>window.__releaseList=()=>resolve(snapshot))}
 return snapshot;
};
const flags=functions.syncReplyReadFlags;
functions.syncReplyReadFlags=ids=>{
 if(window.__deferFlags){window.__deferFlags=false;const states=ids.map(id=>({id,is_read:serverSeen.get(id),read_synced:true}));return new Promise(resolve=>window.__releaseFlags=()=>resolve({states,errors:[]}))}
 return flags(ids);
};
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    # Dashboard detail intent should be consumed once, not on every filter callback change.
    page.locator('.dashboard-reply-list > button').first.click()
    dialog=page.get_by_role('dialog',name='邮件阅读')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('button',name='标为未读',exact=True)).to_be_enabled()
    dialog.get_by_role('button',name='完成',exact=True).click()
    kind=page.get_by_role('button',name='按类型筛选',exact=True)
    kind.click();page.get_by_role('option',name='人工邮件',exact=True).click()
    expect(page.locator('.reply-list-item')).to_have_count(1)
    expect(dialog).to_have_count(0)
    row=page.locator('.reply-list-item')
    row.click();dialog.get_by_role('button',name='标为未读',exact=True).click()
    expect(row).to_have_class('reply-list-item is-unread')
    page.evaluate('window.__deferFlags=true')
    page.get_by_role('button',name='刷新列表',exact=True).click()
    page.wait_for_function("typeof window.__releaseFlags==='function'")
    row.click();expect(row).to_have_class('reply-list-item is-read')
    page.evaluate('window.__releaseFlags()')
    expect(row).to_have_class('reply-list-item is-read')
    expect(page.locator('.nav-unread-badge')).to_have_count(0)
    dialog.get_by_role('button',name='标为未读',exact=True).click()
    expect(row).to_have_class('reply-list-item is-unread')
    page.evaluate('window.__deferList=true')
    page.get_by_role('button',name='刷新列表',exact=True).click()
    page.wait_for_function("typeof window.__releaseList==='function'")
    row.click();expect(row).to_have_class('reply-list-item is-read')
    page.evaluate('window.__releaseList()')
    expect(row).to_have_class('reply-list-item is-read')
    expect(page.locator('.nav-unread-badge')).to_have_count(0)
    assert not errors,errors
    print('PASS: deep-link intent consumed once, stale FLAGS and list snapshots cannot overwrite completed reads, badge consistency')
    browser.close()

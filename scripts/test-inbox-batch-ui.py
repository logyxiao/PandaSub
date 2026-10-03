"""Inbox bulk editor operations against mock APIs; never touches email or user DB."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const library=['a','b','c'].map((letter,i)=>({...functions.listEditors()[0],id:i+1,name:'编辑'+letter,email:letter+'@example.com'}));
functions.listEditors=()=>library.map(e=>({...e}));
functions.setEditorsEnabled=async(ids,enabled)=>{
 if(window.__failBatch)throw new Error('fixture 保存失败');
 if(window.__deferBatch){window.__deferBatch=false;await new Promise(resolve=>window.__finishBatch=resolve)}
 library.forEach(e=>{if(ids.includes(e.id))e.enabled=enabled});return ids.length;
};
functions.deleteEditors=ids=>{for(let i=library.length-1;i>=0;i--)if(ids.includes(library[i].id))library.splice(i,1);return ids.length};
const base={...replies[0],body:'暂停收稿',kind:'human',is_read:false,read_synced:true};
replies.splice(0,replies.length,...Array.from({length:21},(_,i)=>{
 const email=i===19?'unknown@example.com':i===20?'c@example.com':i%2?'b@example.com':'a@example.com';
 return {...base,id:i+1,subject:'暂停通知'+(i+1),from_email:email,recipient:email};
}));
replies.forEach(r=>serverSeen.set(r.id,false));
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='收件箱',exact=True).click()
        kind=page.get_by_role('button',name='按类型筛选',exact=True)
        kind.click();page.get_by_role('option',name='暂停收稿',exact=True).click()
        bar=page.locator('.inbox-batch-bar')
        selectall=page.get_by_role('checkbox',name='全选本页邮件',exact=True)
        selectall.check()
        expect(bar).to_contain_text('已选 20 封邮件 / 2 位编辑（1 封未匹配，操作时跳过）')
        expect(page.get_by_role('complementary',name='邮件阅读')).to_have_count(0)
        assert page.evaluate("window.__calls.filter(c=>['setReplyRead','getReplyContent'].includes(c.name)).length")==0
        page.get_by_role('button',name='下一页',exact=True).click()
        expect(page.get_by_role('checkbox',name='选择邮件 暂停通知21',exact=True)).to_be_visible()
        page.get_by_role('checkbox',name='选择邮件 暂停通知21',exact=True).check()
        expect(bar).to_contain_text('已选 21 封邮件 / 3 位编辑')
        page.evaluate('window.__deferBatch=true')
        bar.get_by_role('button',name='批量暂停编辑',exact=True).click()
        expect(selectall).to_be_disabled()
        expect(bar.get_by_role('button',name='批量删除编辑',exact=True)).to_be_disabled()
        page.evaluate('window.__finishBatch()')
        expect(bar).to_contain_text('已选 0 封邮件 / 0 位编辑')
        expect(page.locator('.reply-list-item')).to_contain_text('编辑已停用')
        assert page.evaluate("window.__calls.filter(c=>c.name==='setEditorsEnabled').map(c=>c.args)")==[[[1,2,3],False]]
        # Failed enable retains selection and current saved state, then can be retried.
        selectall.check();page.evaluate('window.__failBatch=true')
        bar.get_by_role('button',name='批量启用编辑',exact=True).click()
        expect(page.get_by_text('批量操作失败，未作更改：Error: fixture 保存失败',exact=True)).to_be_visible()
        expect(selectall).to_be_checked()
        expect(page.locator('.reply-list-item')).to_contain_text('编辑已停用')
        page.evaluate('window.__failBatch=false')
        bar.get_by_role('button',name='批量启用编辑',exact=True).click()
        expect(bar).to_contain_text('已选 0 封邮件 / 0 位编辑')
        expect(page.locator('.reply-list-item')).not_to_contain_text('编辑已停用')
        # Changing filters clears cross-page selection; restoring the old filter doesn't revive it.
        selectall.check();kind.click();page.get_by_role('option',name='全部类型',exact=True).click()
        expect(bar).to_contain_text('已选 0 封邮件 / 0 位编辑')
        kind.click();page.get_by_role('option',name='暂停收稿',exact=True).click()
        expect(bar).to_contain_text('已选 0 封邮件 / 0 位编辑')
        expect(page.get_by_role('checkbox',name='选择邮件 暂停通知1',exact=True)).to_be_visible()
        page.get_by_role('checkbox',name='选择邮件 暂停通知1',exact=True).check()
        page.get_by_role('checkbox',name='选择邮件 暂停通知3',exact=True).check()
        assert selectall.evaluate('e=>e.indeterminate')
        expect(bar).to_contain_text('已选 2 封邮件 / 1 位编辑')
        bar.get_by_role('button',name='批量删除编辑',exact=True).click()
        confirm=page.get_by_role('alertdialog')
        expect(confirm).to_contain_text('a@example.com')
        expect(confirm).to_contain_text('邮件与投递历史会保留')
        confirm.get_by_role('button',name='取消',exact=True).click()
        assert page.evaluate("window.__calls.filter(c=>c.name==='deleteEditors').length")==0
        bar.get_by_role('button',name='批量删除编辑',exact=True).click()
        confirm.get_by_role('button',name='删除 1 位编辑',exact=True).click()
        expect(bar).to_contain_text('已选 0 封邮件 / 0 位编辑')
        assert page.evaluate("window.__calls.filter(c=>c.name==='deleteEditors').map(c=>c.args)")==[[[1]]]
        expect(page.locator('.reply-list-item')).to_have_count(20)
        page.get_by_role('checkbox',name='选择邮件 暂停通知1',exact=True).check()
        expect(bar).to_contain_text('已选 1 封邮件 / 0 位编辑（1 封未匹配，操作时跳过）')
        expect(bar.get_by_role('button',name='批量删除编辑',exact=True)).to_be_disabled()
        for width,height in [(1280,900),(720,560)]:
            page.set_viewport_size({'width':width,'height':height})
            expect(bar.get_by_role('button',name='批量暂停编辑',exact=True)).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path=f'/tmp/novelsub-inbox-batch-{engine}.png')
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: cross-page selection, deduplication, no read side effects, atomic failure UI, scope reset, confirmed editor-only deletion')

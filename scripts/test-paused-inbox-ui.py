"""Suspended submissions filter and editor state actions, using mock APIs only."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const library=[{...functions.listEditors()[0]}, {...functions.listEditors()[0],id:2,email:'b@example.com',name:'编辑乙'}];
functions.listEditors=()=>library.map(e=>({...e}));
functions.setEditorEnabled=async(id,enabled)=>{
 if(window.__failEditor)throw new Error('fixture 保存失败');
 if(window.__deferEditor){window.__deferEditor=false;await new Promise(resolve=>window.__finishEditor=resolve)}
 const editor=library.find(e=>e.id===id);editor.enabled=enabled;
};
const base={...replies[0],kind:'human',is_read:false,read_synced:true};
replies.splice(0,replies.length,
 {...base,id:1,subject:'编辑甲通知',body:'历史正文'.repeat(200)+'暂停收稿'},
 {...base,id:2,subject:'编辑乙通知',from_email:'b@example.com',recipient:'b@example.com',body:'暂停收稿'},
 {...base,id:3,subject:'普通回复',body:'欢迎投稿'},
 {...base,id:4,subject:'自动通知',kind:'auto',body:'暂停收稿'},
 {...base,id:5,subject:'陌生来信',from_email:'unknown@example.com',recipient:'',delivery_id:null,body:'暂停收稿'});
replies.forEach(r=>serverSeen.set(r.id,r.is_read));
'''
with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        inbox=page.get_by_role('navigation',name='主导航').get_by_role('button',name='收件箱',exact=True)
        inbox.click()
        kind=page.get_by_role('button',name='按类型筛选',exact=True)
        expect(kind).to_have_text('全部类型')
        kind.click();page.get_by_role('option',name='暂停收稿',exact=True).click()
        rows=page.locator('.reply-list-item');expect(rows).to_have_count(4)
        expect(rows.filter(has_text='普通回复')).to_have_count(0)
        rows.filter(has_text='编辑甲通知').click()
        pane=page.get_by_role('complementary',name='邮件阅读')
        status=pane.locator('.inbox-editor-status')
        expect(status).to_contain_text('a@example.com')
        page.evaluate('window.__deferEditor=true')
        status.get_by_role('button',name='停用编辑',exact=True).click()
        expect(status.get_by_role('button',name='保存中…')).to_be_disabled()
        rows.filter(has_text='编辑乙通知').click()
        expect(status).to_contain_text('b@example.com')
        page.evaluate('window.__finishEditor()')
        expect(status.get_by_role('button',name='停用编辑',exact=True)).to_be_enabled()
        rows.filter(has_text='编辑甲通知').click()
        expect(status.get_by_role('button',name='启用编辑',exact=True)).to_be_visible()
        expect(rows.filter(has_text='编辑甲通知')).to_contain_text('编辑已停用')
        for width,height in [(1280,900),(720,560)]:
            page.set_viewport_size({'width':width,'height':height})
            expect(status.get_by_role('button',name='启用编辑',exact=True)).to_be_visible()
            assert pane.evaluate('e=>e.scrollWidth<=e.clientWidth')
            assert rows.first.evaluate('e=>e.scrollWidth<=e.clientWidth')
            assert rows.first.locator('.reply-list-tags').evaluate("""e=>{
                const boxes=[...e.children].map(n=>n.getBoundingClientRect());
                return boxes.every((a,i)=>boxes.slice(i+1).every(b=>a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1));
            }""")
        page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path=f'/tmp/novelsub-paused-inbox-{engine}.png')
        # Reopening the view reads the persisted enabled flag, not transient UI state.
        inbox.click();rows.filter(has_text='编辑甲通知').click()
        expect(status.get_by_role('button',name='启用编辑',exact=True)).to_be_visible()
        page.evaluate('window.__failEditor=true')
        status.get_by_role('button',name='启用编辑',exact=True).click()
        expect(page.get_by_text('编辑状态保存失败：Error: fixture 保存失败',exact=True)).to_be_visible()
        expect(status.get_by_role('button',name='启用编辑',exact=True)).to_be_enabled()
        page.evaluate('window.__failEditor=false')
        status.get_by_role('button',name='启用编辑',exact=True).click()
        expect(status.get_by_role('button',name='停用编辑',exact=True)).to_be_visible()
        calls=page.evaluate("window.__calls.filter(c=>c.name==='setEditorEnabled').map(c=>c.args)")
        assert calls==[[1,False],[1,True],[1,True]],calls
        rows.filter(has_text='陌生来信').click()
        expect(status).to_contain_text('未匹配到编辑库中的邮箱')
        expect(status.get_by_role('button')).to_have_count(0)
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: suspension filtering, explicit editor state, async switching, persistence, failure recovery, unmatched sender')

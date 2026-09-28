"""All-type inbox entry and an interactive, independently scrolling reading pane."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base={...replies[0],account_id:1,kind:'human',is_read:false,read_synced:true};
replies.splice(0,replies.length,
 {...base,id:1,subject:'第一封未读邮件'},
 {...base,id:2,subject:'第二封未读邮件'},
 {...base,id:3,subject:'自动回执',kind:'auto',is_read:true},
 {...base,id:4,subject:'退信通知',kind:'bounce'},
 ...Array.from({length:20},(_,i)=>({...base,id:i+5,subject:'历史邮件'+i,is_read:true})));
replies.forEach(r=>serverSeen.set(r.id,r.is_read));
const content=id=>({from:[],to:[],cc:[],bcc:[],reply_to:[],sent_at:'',subject:'预览主题 '+id,
 text:Array.from({length:50},(_,i)=>'邮件 '+id+' 的正文第 '+i+' 段').join('\n'),html:'',attachments:[],inline_images:{},complete:true});
functions.getReplyContent=id=>id===1?new Promise(resolve=>window.__finishFirst=()=>resolve(content(id))):content(id);
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
        inbox=page.get_by_role('navigation',name='主导航').get_by_role('button',name='收件箱',exact=True)
        inbox.click()
        kind=page.get_by_role('button',name='按类型筛选',exact=True)
        expect(kind).to_have_text('全部类型')
        rows=page.locator('.reply-list-item')
        expect(rows.filter(has_text='自动回执')).to_be_visible()
        expect(rows.filter(has_text='退信通知')).to_be_visible()
        rows.filter(has_text='第一封未读邮件').click()
        pane=page.get_by_role('complementary',name='邮件阅读')
        expect(pane).to_be_visible()
        expect(page.get_by_role('dialog')).to_have_count(0)
        expect(page.locator('.modal-backdrop')).to_have_count(0)
        assert not page.locator('.reply-list').evaluate("e=>!!e.closest('[inert]')")
        page.wait_for_function("typeof window.__finishFirst==='function'")
        # Switch directly while the first request is still pending.
        rows.filter(has_text='第二封未读邮件').click()
        expect(pane.get_by_role('heading',name='预览主题 2',exact=True)).to_be_visible()
        expect(rows.filter(has_text='预览主题 2')).to_have_attribute('aria-current','true')
        page.evaluate('window.__finishFirst()')
        expect(pane).to_contain_text('邮件 2 的正文第 0 段')
        expect(pane).not_to_contain_text('邮件 1 的正文第 0 段')
        page.wait_for_function("window.__calls.filter(c=>c.name==='setReplyRead').length===2")
        pane.locator('.inbox-preview-body').evaluate('e=>e.scrollTop=250')
        assert page.locator('.reply-list').evaluate('e=>e.scrollTop')==0
        page.locator('.reply-list').evaluate('e=>e.scrollTop=200')
        assert pane.locator('.inbox-preview-body').evaluate('e=>e.scrollTop')==250
        page.locator('.reply-list').evaluate('e=>e.scrollTop=0')
        rows.filter(has_text='自动回执').click()
        expect(pane.get_by_role('heading',name='预览主题 3',exact=True)).to_be_visible()
        assert pane.locator('.inbox-preview-body').evaluate('e=>e.scrollTop')==0
        page.screenshot(path=f'/tmp/novelsub-inbox-pane-{engine}.png')
        for width,height in [(960,650),(720,560)]:
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_function("document.querySelector('.inbox-preview').getBoundingClientRect().bottom <= innerHeight")
            expect(pane.get_by_role('button',name='关闭预览',exact=True)).to_be_visible()
            expect(pane.get_by_role('button',name='完成',exact=True)).to_be_visible()
            left=page.locator('.reply-inbox').bounding_box();right=pane.bounding_box()
            assert right['x']>=left['x']+left['width'],(left,right)
            assert right['y']+right['height']<=height+1,(width,height,right)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert pane.evaluate('e=>e.scrollWidth<=e.clientWidth')
            assert page.locator('.inbox-toolbar').evaluate('''e=>{
              const boxes=[...e.querySelectorAll('.select-control,.editor-search,.toolbar-actions')].map(n=>n.getBoundingClientRect()).filter(b=>b.width&&b.height);
              return boxes.every((a,i)=>boxes.slice(i+1).every(b=>a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1));
            }'''), 'Inbox filters and actions must not overlap'
            rows.filter(has_text='退信通知' if width==960 else '预览主题 3').click()
        page.screenshot(path=f'/tmp/novelsub-inbox-pane-narrow-{engine}.png')
        page.keyboard.press('Escape');expect(pane).to_have_count(0)
        expect(rows.filter(has_text='预览主题 3')).to_be_focused()
        kind.click();page.get_by_role('option',name='人工邮件',exact=True).click()
        expect(kind).to_have_text('人工邮件')
        inbox.click();expect(kind).to_have_text('全部类型')
        page.set_viewport_size({'width':1280,'height':900})
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='工作台',exact=True).click()
        page.locator('.dashboard-reply-list > button').first.click()
        expect(kind).to_have_text('全部类型')
        expect(pane).to_be_visible()
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: all-type entry, direct switching, stale result isolation, selected row, independent scroll, responsive right pane and Escape focus')

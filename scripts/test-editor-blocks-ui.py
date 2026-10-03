"""Pair-specific blacklist evidence, editor filters, resolution and global delivery notices."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
const originalEditors=functions.listEditors;
window.__blocks=['sender@example.com','other@example.com'].map(sender_email=>({sender_email,recipient_email:'a@example.com',editor_name:'编辑甲',platform:'平台',reason:'服务端拒绝投递（550）：The sender is blacklisted by the recipient, please contact the recipient.',first_seen:'2026-10-01 12:00:00',last_seen:'2026-10-03 12:00:00'}));
functions.listEditorBlocks=()=>window.__blocks;
functions.listEditors=()=>[...originalEditors().map(e=>({...e,blocked_senders:window.__blocks.filter(b=>b.recipient_email===e.email).map(b=>b.sender_email)})),{...originalEditors()[0],id:2,email:'peer@example.com',name:'编辑乙',blocked_senders:[]}];
functions.clearEditorBlock=(sender,recipient)=>{window.__blocks=window.__blocks.filter(b=>b.sender_email!==sender||b.recipient_email!==recipient)};
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        nav=page.get_by_role('navigation',name='主导航')
        nav.get_by_role('button',name='编辑库',exact=True).click()
        page.get_by_role('tab',name='有拉黑记录').click()
        expect(page.get_by_role('button',name='编辑甲',exact=True)).to_be_visible()
        expect(page.get_by_role('button',name='编辑乙',exact=True)).to_have_count(0)
        page.get_by_role('button',name='已拉黑 2 个发件邮箱',exact=True).click()
        d=page.get_by_role('dialog',name='编辑拉黑记录')
        expect(d.locator('.editor-block-entry')).to_have_count(2)
        expect(d).to_contain_text('保持发件邮箱不变')
        d.get_by_role('button',name='拉黑记录发件邮箱',exact=True).click()
        page.get_by_role('option',name='sender@example.com',exact=True).click()
        expect(d.locator('.editor-block-entry')).to_have_count(1)
        d.get_by_text('查看服务器拒收原因',exact=True).click()
        expect(d).to_contain_text('The sender is blacklisted by the recipient')
        d.get_by_role('button',name='标记已解除',exact=True).click()
        confirm=page.get_by_role('alertdialog',name='标记拉黑已解除？')
        expect(confirm).to_contain_text('不会解除对方邮箱的实际拦截')
        confirm.get_by_role('button',name='取消',exact=True).click()
        assert not page.evaluate("window.__calls.some(c=>c.name==='clearEditorBlock')")
        d.get_by_role('button',name='标记已解除',exact=True).click()
        confirm.get_by_role('button',name='确认已解除',exact=True).click()
        expect(d.locator('.editor-block-entry')).to_have_count(0)
        d.get_by_role('button',name='拉黑记录发件邮箱',exact=True).click()
        page.get_by_role('option',name='全部发件邮箱',exact=True).click()
        expect(d).to_contain_text('被拉黑的发件邮箱：other@example.com')
        expect(d.locator('.editor-block-entry')).to_have_count(1)
        page.set_viewport_size({'width':720,'height':560})
        page.screenshot(path=f'/tmp/novelsub-editor-blocks-{engine}.png')
        assert d.evaluate('e=>e.scrollWidth<=e.clientWidth')
        d.get_by_role('button',name='关闭',exact=True).click()
        expect(page.get_by_role('button',name='已拉黑 1 个发件邮箱',exact=True)).to_be_visible()
        nav.get_by_role('button',name='工作台',exact=True).click()
        page.evaluate("window.__emit('log',{id:100,category:'editor_replacement',level:'warning',message:'发件邮箱 sender@example.com 被编辑甲拉黑；已自动改投同平台编辑乙，发件邮箱保持不变。'})")
        expect(page.locator('.toasts')).to_contain_text('已自动改投同平台编辑乙')
        page.evaluate("window.__emit('log',{id:101,category:'editor_replacement',level:'error',message:'没有可用同平台编辑，已跳过，请调整编辑名单。'})")
        expect(page.locator('.toasts')).to_contain_text('没有可用同平台编辑')
        assert not page.evaluate("window.__calls.some(c=>['sendManualDelivery','resendDelivery','createTask'].includes(c.name))")
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: sender-specific editor badges/filter/detail, clear one pair with confirmation, narrow layout and global routing notices')

"""Opening plan records directly must load the local editor library before adding recipients."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
task.status='stopped';
window.__libraryExtra=false;
const library=[...functions.listEditors(),{...functions.listEditors()[0],id:2,name:'本地新增编辑',email:'new-local@example.com',platform:'墨墨言情网'}];
functions.listEditors=()=>{if(window.__failLibrary)throw new Error('fixture 编辑库读取失败');return [...library,...(window.__libraryExtra?[{...library[1],id:3,name:'再次导入编辑',email:'later@example.com'}]:[])].map(e=>({...e}))};
functions.updateManuscript=(id,input)=>Object.assign(m,input);
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='投稿计划',exact=True).click()
        assert not page.evaluate("window.__calls.some(c=>c.name==='listEditors')")
        page.locator('.plans-table').get_by_role('button',name='记录',exact=True).click()
        dialog=page.get_by_role('dialog')
        dialog.get_by_role('button',name='添加编辑',exact=True).click()
        picker=page.locator('.send-detail-picker')
        expect(picker).to_contain_text('本地新增编辑')
        expect(picker).not_to_contain_text('编辑库还是空的')
        assert page.evaluate("window.__calls.filter(c=>c.name==='listEditors').at(-1).args")==[True]
        picker.get_by_role('button',name='添加',exact=True).click()
        page.wait_for_function("window.__calls.some(c=>c.name==='updateManuscript')")
        added=page.evaluate("window.__calls.filter(c=>c.name==='updateManuscript').at(-1).args[1].recipients")
        assert any('new-local@example.com' in value for value in added),added
        page.keyboard.press('Escape');expect(dialog).to_have_count(0)
        page.evaluate('window.__failLibrary=true')
        page.locator('.plans-table').get_by_role('button',name='记录',exact=True).click()
        expect(page.locator('.toasts')).to_contain_text('fixture 编辑库读取失败')
        expect(dialog).to_have_count(0)
        page.evaluate('window.__failLibrary=false;window.__libraryExtra=true')
        page.locator('.plans-table').get_by_role('button',name='记录',exact=True).click()
        dialog.get_by_role('button',name='添加编辑',exact=True).click()
        expect(picker).to_contain_text('再次导入编辑')
        expect(picker).not_to_contain_text('本地新增编辑')
        assert not page.evaluate("window.__calls.some(c=>['sendManualDelivery','resendDelivery','createTask','startTask'].includes(c.name))")
        page.screenshot(path=f'/tmp/novelsub-plan-detail-editors-{engine}.png')
        print(f'PASS {engine}: direct record entry loads library, add persists without SMTP, read failure does not show false empty state, reopen refreshes imports')
        assert not errors,errors
        browser.close()

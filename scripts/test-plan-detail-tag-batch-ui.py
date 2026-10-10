"""Tag filtering and batch appends use mock data only; no user database or SMTP."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
task.status='completed';task.sent=3;task.total=3;
deliveries.push({id:2,task_id:1,manuscript_id:1,recipient:'b@example.com',sent_at:'2026-09-06 10:00:00'},
 {id:3,task_id:1,manuscript_id:1,recipient:'c@example.com',sent_at:'2026-09-06 10:00:00'});
const prototype=functions.listEditors()[0];
const editor=(id,name,email,platform,work_type=['甜宠'],extra={})=>({...prototype,id,name,email,platform,work_type,...extra});
const library=[editor(1,'已有编辑','a@example.com','已有平台'),
 editor(2,'已有平台另一位','same-platform@example.com','已有平台'),
 editor(3,'普通编辑','regular@example.com','新平台'),
 editor(4,'收藏编辑','favorite@example.com','新平台',['甜宠'],{favorited:true}),
 editor(5,'第二平台编辑','second@example.com','第二平台'),
 editor(6,'悬疑编辑','suspense@example.com','悬疑平台',['悬疑']),
 editor(7,'停用编辑','disabled@example.com','停用平台',['甜宠'],{enabled:false}),
 editor(8,'无效邮箱','invalid','无效平台'),
 editor(9,'古言编辑','period@example.com','古言平台',['甜宠','古言'])];
functions.listEditors=()=>library.map(e=>({...e}));
functions.updateManuscript=(id,input)=>{
 if(window.__failAppend)throw new Error('fixture 保存名单失败');
 const save=()=>{Object.assign(m,input);if(task.status==='completed'&&m.recipients.length>task.total){task.status='stopped';task.total=m.recipients.length}};
 if(window.__deferAppend)return new Promise(resolve=>{window.__finishAppend=()=>{save();resolve()}});
 save();
};
functions.startTask=()=>{task.status='running';window.__emit('task',{...task})};
'''

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 1000}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda e: (errors.append(str(e)), print(f'{engine} browser error: {e}', flush=True)))
        page.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK+EXTRA))
        page.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        page.get_by_role('navigation', name='主导航').get_by_role('button', name='投稿计划', exact=True).click()
        expect(page.locator('.plans-table').get_by_role('button',name='重新发送',exact=True)).to_be_visible(timeout=15000)
        page.locator('.plans-table').get_by_role('button', name='记录', exact=True).click()
        record = page.get_by_role('dialog', name='记录', exact=True)
        record.get_by_role('button', name='添加编辑', exact=True).click()
        picker = page.locator('.send-detail-picker')
        expect(picker).not_to_contain_text('停用编辑')
        expect(picker).not_to_contain_text('无效邮箱')
        picker.get_by_role('button', name='筛选标签甜宠', exact=True).click()
        picker.get_by_role('button', name='选择筛选标签', exact=True).click()
        tag_dialog = page.get_by_role('dialog', name='筛选收稿标签')
        tag_dialog.get_by_role('button', name='排除标签古言', exact=True).click()
        tag_dialog.get_by_role('button', name='应用筛选', exact=True).click()
        expect(picker).not_to_contain_text('悬疑编辑')
        expect(picker).not_to_contain_text('古言编辑')
        batch = picker.get_by_role('button', name='批量添加 2 位', exact=True)
        expect(batch).to_be_enabled()
        page.evaluate('window.__failAppend=true')
        batch.click()
        expect(page.locator('.toasts')).to_contain_text('fixture 保存名单失败')
        expect(picker).to_be_visible()
        assert page.evaluate('window.__manuscript.recipients') == ['a@example.com','b@example.com','c@example.com']
        page.evaluate('window.__failAppend=false;window.__deferAppend=true')
        batch.click()
        page.wait_for_function("typeof window.__finishAppend==='function'")
        expect(picker.get_by_role('button', name='添加中…', exact=True)).to_be_disabled()
        for button in picker.get_by_role('button', name='添加', exact=True).all():
            expect(button).to_be_disabled()
        assert page.evaluate("window.__calls.filter(c=>c.name==='updateManuscript').length") == 2
        page.evaluate('window.__finishAppend()')
        expect(picker).to_have_count(0)
        recipients = page.evaluate('window.__manuscript.recipients')
        assert recipients[:3] == ['a@example.com','b@example.com','c@example.com'], recipients
        assert len(recipients) == 5, recipients
        assert any('favorite@example.com' in r for r in recipients)
        assert any('second@example.com' in r for r in recipients)
        assert not any('regular@example.com' in r or 'same-platform@example.com' in r for r in recipients)
        record.get_by_role('button', name='添加编辑', exact=True).click()
        picker.get_by_role('button', name='筛选标签甜宠', exact=True).click()
        picker.get_by_role('button', name='选择筛选标签', exact=True).click()
        tag_dialog.get_by_role('button', name='排除标签古言', exact=True).click()
        tag_dialog.get_by_role('button', name='应用筛选', exact=True).click()
        expect(picker.get_by_role('button', name='批量添加 0 位', exact=True)).to_be_disabled()
        assert not page.evaluate("window.__calls.some(c=>['sendManualDelivery','resendDelivery','createTask','startTask'].includes(c.name))")
        page.screenshot(path=f'/tmp/novelsub-detail-tag-batch-{engine}.png')
        record.get_by_role('button',name='关闭',exact=True).click()
        expect(page.locator('.plans-table').get_by_role('button',name='继续发送',exact=True)).to_be_visible()
        expect(page.locator('.plan-progress-count')).to_have_text('3 / 5')
        page.locator('.plans-table').get_by_role('button',name='继续发送',exact=True).click()
        expect(page.get_by_role('alertdialog')).to_have_count(0)
        page.wait_for_function("window.__calls.filter(c=>c.name==='startTask').length===1")
        assert not errors, errors
        print(f'PASS {engine}: batch appends and failure recovery; completed plan becomes continue with preserved 3/5 progress and no full-resend confirmation')
        browser.close()

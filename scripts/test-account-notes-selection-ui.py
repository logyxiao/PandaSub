"""Account notes and explicit sender selection, using mock persistence and mail APIs."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
Object.assign(accounts[0],{smtp_host:'smtp.example.com',smtp_port:465,imap_host:'imap.example.com',imap_port:993,check_replies:true,notes:'短篇专用'});
task.status='stopped';task.sent=0;
functions.addAccount=input=>{const id=accounts.length+1;accounts.push({...input,id,sent_today:0});return id};
functions.updateAccount=(id,input)=>Object.assign(accounts.find(a=>a.id===id),input);
functions.addManuscript=input=>{Object.assign(m,input);return m.id};
functions.updateManuscript=(id,input)=>Object.assign(m,input);
'''

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width':1280, 'height':900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK+EXTRA))
        page.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        nav = page.get_by_role('navigation', name='主导航')
        nav.get_by_role('button', name='邮箱管理', exact=True).click()
        expect(page.get_by_role('table')).to_contain_text('备注：短篇专用')
        page.get_by_role('button', name='添加邮箱', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('邮箱地址', exact=True).fill('backup@qq.com')
        dialog.get_by_label('授权码', exact=True).fill('fixture')
        dialog.get_by_label('备注（可选）', exact=True).fill('  备用邮箱\n海外投稿  ')
        dialog.get_by_role('button', name='保存配置', exact=True).click()
        expect(dialog).to_have_count(0)
        row = page.get_by_role('row').filter(has_text='backup@qq.com')
        expect(row).to_contain_text('备用邮箱')
        row.get_by_role('button', name='编辑', exact=True).click()
        expect(dialog.get_by_label('备注（可选）', exact=True)).to_have_value('备用邮箱\n海外投稿')
        expect(dialog.get_by_label('授权码', exact=True)).to_have_value('')
        dialog.get_by_label('备注（可选）', exact=True).fill('')
        dialog.get_by_role('button', name='保存配置', exact=True).click()
        expect(row.locator('.account-note')).to_have_count(0)
        row.get_by_role('button', name='编辑', exact=True).click()
        expect(dialog.get_by_label('备注（可选）', exact=True)).to_have_value('')
        dialog.get_by_role('button', name='取消', exact=True).click()
        nav.get_by_role('button', name='投稿计划', exact=True).click()
        # Existing explicit choices are restored.
        page.get_by_role('button', name='编辑计划', exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        picker = page.locator('.account-pick-list')
        expect(picker.locator('input:checked')).to_have_count(1)
        expect(picker).to_contain_text('备注：短篇专用')
        page.get_by_role('button', name='返回', exact=True).click()
        page.get_by_role('button', name='新建计划', exact=True).click()
        page.get_by_label('作品名称', exact=True).fill('默认不选邮箱')
        page.locator('.plan-desk input[type=file]').set_input_files({'name':'稿件.txt','mimeType':'text/plain','buffer':'有效文稿'.encode()})
        page.get_by_role('button', name='下一步：选择编辑').click()
        page.get_by_role('button', name='下一步：选择邮箱').click()
        expect(picker.locator('input:checked')).to_have_count(0)
        expect(page.locator('.plan-account-caption')).to_contain_text('已选 0 个')
        send = page.get_by_role('button', name='开始发送', exact=True)
        expect(send).to_be_disabled()
        page.get_by_role('button', name='测试发送', exact=True).click()
        expect(page.get_by_text('还没有勾选参与发送的邮箱，请先勾选一个', exact=True)).to_be_visible()
        assert not page.evaluate("window.__calls.some(c=>c.name==='sendTestEmail'||c.name==='createTask')")
        picker.get_by_role('checkbox', name='选择 fixture@example.com', exact=True).check()
        expect(picker.locator('input:checked')).to_have_count(1)
        expect(send).to_be_enabled()
        picker.get_by_role('checkbox', name='取消选择 fixture@example.com', exact=True).uncheck()
        expect(picker.locator('input:checked')).to_have_count(0)
        expect(send).to_be_disabled()
        page.screenshot(path=f'/tmp/novelsub-account-selection-{engine}.png')
        page.get_by_role('button', name='保存草稿', exact=True).click()
        expect(page.locator('.plans-table')).to_be_visible()
        assert page.evaluate('window.__manuscript.account_ids') == []
        page.get_by_role('button', name='编辑计划', exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        expect(picker.locator('input:checked')).to_have_count(0)
        expect(send).to_be_disabled()
        assert not errors, errors
        browser.close()
        print(f'PASS {engine}: note create/edit/clear, saved choices, empty defaults, last deselection, send guards, empty draft reopening')

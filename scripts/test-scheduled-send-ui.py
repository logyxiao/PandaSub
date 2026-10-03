"""Schedule UI regression with mock IPC only; no email is sent."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
task.status='stopped';task.sent=0;
functions.updateManuscript=(id,input)=>Object.assign(m,input);
functions.updateTask=(id,input)=>{if(window.__failSchedule)throw new Error('fixture 预约失败');Object.assign(task,input,{status:input.schedule_type==='scheduled'?'scheduled':'running'});window.__emit('task',{...task})};
functions.startTask=()=>{task.status='running';window.__emit('task',{...task})};
functions.stopTask=()=>{task.status='stopped';window.__emit('task',{...task})};
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce',timezone_id='Asia/Shanghai')
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='投稿计划',exact=True).click()
        page.locator('.plans-table').get_by_role('button',name='编辑计划',exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        mode=page.get_by_role('button',name='开始发送方式',exact=True)
        expect(mode).to_have_text('立即发送')
        mode.click();page.get_by_role('option',name='定时开始发送',exact=True).click()
        at=page.get_by_label('定时开始时间',exact=True)
        book=page.get_by_role('button',name='预约发送',exact=True)
        expect(book).to_be_disabled()
        at.fill('2000-01-01T10:00');expect(book).to_be_disabled()
        expect(page.get_by_role('alert')).to_contain_text('晚于现在')
        at.fill('2096-10-03T10:30');expect(book).to_be_enabled()
        for width,height in [(1280,900),(720,560)]:
            page.set_viewport_size({'width':width,'height':height})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path=f'/tmp/novelsub-scheduled-send-{engine}.png')
        page.evaluate('window.__failSchedule=true');book.click()
        expect(page.get_by_text('Error: fixture 预约失败',exact=True)).to_be_visible()
        expect(at).to_have_value('2096-10-03T10:30')
        page.evaluate('window.__failSchedule=false');book.click()
        expect(page.locator('.plans-table')).to_contain_text('预约开始：2096-10-03 10:30:00')
        assert page.evaluate("window.__calls.filter(c=>c.name==='updateTask').at(-1).args[1].scheduled_at")=='2096-10-03 10:30:00'
        assert not page.evaluate("window.__calls.some(c=>c.name==='startTask')")
        # Edit an existing reservation: restore its date and update it, not a new task.
        page.locator('.plans-table').get_by_role('button',name='编辑计划',exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        expect(at).to_have_value('2096-10-03T10:30')
        at.fill('2096-10-04T11:45');book.click()
        expect(page.locator('.plans-table')).to_contain_text('预约开始：2096-10-04 11:45:00')
        page.locator('.plans-table').get_by_role('button',name='立即开始',exact=True).click()
        confirm=page.get_by_role('alertdialog',name='提前开始发送？')
        expect(confirm).to_contain_text('2096-10-04 11:45:00')
        confirm.get_by_role('button',name='取消',exact=True).click()
        assert not page.evaluate("window.__calls.some(c=>c.name==='startTask')")
        page.locator('.plans-table').get_by_role('button',name='更多操作').click()
        page.get_by_role('menuitem',name='取消预约',exact=True).click()
        expect(page.locator('.plans-table').get_by_role('button',name='开始发送',exact=True)).to_be_visible()
        expect(page.locator('.plans-table')).not_to_contain_text('预约开始：')
        assert page.evaluate("window.__calls.filter(c=>c.name==='stopTask').length")==1
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: schedule entry, invalid time, local time payload, failure retry, reschedule, early-start confirmation, cancellation')

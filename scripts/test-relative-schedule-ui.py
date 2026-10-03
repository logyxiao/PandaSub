"""Relative scheduling and remembered interval, isolated mock APIs only."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
task.id=2;task.status='stopped';task.sent=0;
const parent={...task,id:1,name:'上个投稿计划',manuscript_ids:[2],status:'running'};
functions.listTasks=()=>[task,parent];
m.send_interval_from_sec=111;m.send_interval_to_sec=222;
const initialSettings=functions.getSettings();window.__lastInterval=[333,444];
functions.getSettings=()=>({...initialSettings,last_send_interval_from_sec:window.__lastInterval[0],last_send_interval_to_sec:window.__lastInterval[1]});
functions.updateManuscript=(id,input)=>{Object.assign(m,input);window.__lastInterval=[input.send_interval_from_sec,input.send_interval_to_sec]};
functions.addManuscript=input=>{window.__lastInterval=[input.send_interval_from_sec,input.send_interval_to_sec];return 3};
functions.updateTask=(id,input)=>{Object.assign(task,input,{status:'scheduled'});window.__emit('task',{...task})};
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
        page.locator('.plans-table').get_by_role('button',name='编辑计划',exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        expect(page.get_by_role('spinbutton',name='最短间隔 秒',exact=True)).to_have_value('111')
        mode=page.get_by_role('button',name='开始发送方式',exact=True)
        mode.click();page.get_by_role('option',name='上个计划结束后发送',exact=True).click()
        expect(page.get_by_role('button',name='等待的投稿计划',exact=True)).to_have_text('上个投稿计划（#1）')
        delay=page.get_by_role('button',name='结束后等待',exact=True)
        expect(delay).to_have_text('半小时')
        delay.click();page.get_by_role('option',name='1 小时',exact=True).click()
        expect(page.get_by_role('button',name='预约发送',exact=True)).to_be_enabled()
        delay.click();page.get_by_role('option',name='自定义分钟数',exact=True).click()
        minutes=page.get_by_label('延迟分钟数',exact=True)
        minutes.fill('0');expect(page.get_by_role('button',name='预约发送',exact=True)).to_be_disabled()
        minutes.fill('60');expect(minutes).to_be_visible()
        minutes.fill('75')
        page.get_by_role('spinbutton',name='最短间隔 秒',exact=True).fill('45')
        page.get_by_role('spinbutton',name='最长间隔 秒',exact=True).fill('90')
        page.screenshot(path=f'/tmp/novelsub-relative-schedule-{engine}.png')
        page.get_by_role('button',name='预约发送',exact=True).click()
        expect(page.locator('.plans-table')).to_contain_text('等待「上个投稿计划」结束后 75 分钟')
        payload=page.evaluate("window.__calls.filter(c=>c.name==='updateTask').at(-1).args[1]")
        assert payload['schedule_type']=='after_previous' and payload['after_task_id']==1 and payload['delay_minutes']==75 and payload['scheduled_at'] is None,payload
        assert not page.evaluate("window.__calls.some(c=>c.name==='startTask')")
        page.locator('.plans-table').get_by_role('button',name='编辑计划',exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        expect(mode).to_have_text('上个计划结束后发送');expect(minutes).to_have_value('75')
        page.get_by_role('button',name='返回',exact=True).click()
        page.get_by_role('button',name='新建计划',exact=True).click()
        page.get_by_placeholder('作品名称',exact=True).fill('新的计划')
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        expect(page.get_by_role('spinbutton',name='最短间隔 秒',exact=True)).to_have_value('45')
        expect(page.get_by_role('spinbutton',name='最长间隔 秒',exact=True)).to_have_value('90')
        page.get_by_role('spinbutton',name='最短间隔 秒',exact=True).fill('55')
        page.get_by_role('button',name='保存草稿',exact=True).click()
        expect(page.get_by_role('button',name='新建计划',exact=True)).to_be_visible()
        page.get_by_role('button',name='新建计划',exact=True).click()
        page.get_by_role('tab').filter(has_text='选择发送邮箱').click()
        expect(page.get_by_role('spinbutton',name='最短间隔 秒',exact=True)).to_have_value('55')
        expect(page.get_by_role('spinbutton',name='最长间隔 秒',exact=True)).to_have_value('90')
        page.set_viewport_size({'width':720,'height':560})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: default predecessor, delay presets/custom validation, persisted relative schedule, restored editing and remembered draft interval')

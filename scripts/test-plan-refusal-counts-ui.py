"""Completed refusals use processed progress without inflating sent mail. Mock APIs only."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
task.status='completed';task.sent=1;task.skipped=2;task.total=3;
const originalSummary=functions.deliverySummaryPage;
functions.deliverySummaryPage=(...args)=>{
 const result=originalSummary(...args);
 return {...result,blacklist_total:1,invalid_total:1,skipped_total:2,
  items:result.items.map(r=>({...r,skip_kind:r.row_index===1?'blacklist':r.row_index===2?'recipient_invalid':null}))};
};
'''
with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width':1280, 'height':900})
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r: r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r: r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='投稿计划',exact=True).click()
        expect(page.locator('.plan-progress-count')).to_have_text('3 / 3')
        progress=page.get_by_role('progressbar',name='《回归测试计划》发送进度')
        expect(progress).to_have_attribute('aria-valuenow','3')
        expect(progress).to_have_attribute('aria-valuetext','已发送 1 封，已处理拒收 2 个，共 3 个目标')
        page.get_by_role('button',name='记录',exact=True).click()
        record=page.get_by_role('dialog',name='记录',exact=True)
        expect(record).to_contain_text('已发送 1 · 未发送 0 · 被拉黑 1 · 地址失效 1')
        expect(record).to_contain_text('被拉黑，已处理')
        expect(record).to_contain_text('地址失效，已处理')
        assert not page.evaluate("window.__calls.some(c=>['startTask','sendManualDelivery','resendDelivery'].includes(c.name))")
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: completed 3/3 processed, 1 actual send, refusal totals and per-recipient states')

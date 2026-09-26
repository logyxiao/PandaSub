"""Task progress events must not scan recipients of thousands of off-screen drafts."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
window.__recipientReads=0;
const plans=Array.from({length:3000},(_,index)=>{
 const plan={...m,id:index+1,title:'计划 '+(index+1)};
 Object.defineProperty(plan,'recipients',{get:()=>{window.__recipientReads++;return ['a@example.com','b@example.com','c@example.com']}});
 return plan;
});
functions.listManuscripts=()=>plans;
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    page.get_by_role('navigation',name='主导航').get_by_role('button',name='投稿计划',exact=True).click()
    expect(page.locator('.plans-table tbody tr')).to_have_count(6)
    expect(page.locator('.plans-filters')).to_contain_text('3000 个结果')
    assert page.evaluate('window.__recipientReads')<20
    page.evaluate('window.__recipientReads=0')
    for sent in range(2,8):
        page.evaluate('(sent)=>window.__emit("task",{...window.__task,sent,total:10})',sent)
        expect(page.locator('.plan-progress-count')).to_have_text(f'{sent} / 10')
    assert page.evaluate('window.__recipientReads')<20
    page.get_by_label('搜索投稿计划').fill('计划 3000')
    expect(page.locator('.plans-table tbody tr')).to_have_count(1)
    expect(page.locator('.plans-table')).to_contain_text('计划 3000')
    expect(page.locator('.plans-table')).to_contain_text('草稿')
    assert not errors,errors
    print('PASS: 3000 plans render 6 rows; task events do not traverse off-screen recipient arrays; persisted progress and draft search retained')
    browser.close()

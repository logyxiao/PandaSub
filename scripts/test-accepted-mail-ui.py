"""Read exact candidate mail without confirming acceptance or changing server read state."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
from accepted_ui_fixtures import ACCEPTED

EXTRA = r'''
const getReply=functions.getReply;
functions.getReply=async id=>{
 if(window.__slowReply){window.__slowReply=false;await new Promise(resolve=>window.__finishReply=resolve)}
 if(window.__missingReply)return null;
 return getReply(id);
};
functions.getLocalReplyContent=id=>({from:[],to:[],cc:[],bcc:[],reply_to:[],sent_at:'',text:getReply(id).body,html:'',attachments:[],inline_images:{},complete:false});
functions.getReplyContent=()=>{throw new Error('fixture offline')};
'''

with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+ACCEPTED+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='过稿统计',exact=True).click()
        candidate=page.locator('.accepted-candidate').filter(has_text='误判的回复')
        candidate.get_by_role('button',name='查看邮件',exact=True).click()
        dialog=page.get_by_role('dialog',name='核对邮件',exact=True)
        expect(dialog).to_contain_text('核对邮件3')
        expect(dialog).to_contain_text('很抱歉稿件未能过审')
        expect(dialog).to_contain_text('祝宝子早日过稿')
        expect(dialog).to_contain_text('fixture@example.com')
        expect(dialog).to_contain_text('fixture offline')
        page.screenshot(path=f'/tmp/novelsub-accepted-mail-{engine}.png')
        dialog.get_by_role('button',name='关闭',exact=True).last.click()
        assert page.evaluate('window.__acceptedWorks.length')==0
        assert not page.evaluate("window.__calls.some(c=>['setReplyRead','addAcceptedWork'].includes(c.name))")
        # Closing a slow request cannot reopen it over another candidate.
        page.evaluate('window.__slowReply=true')
        candidate.get_by_role('button',name='误判的回复',exact=True).click()
        expect(dialog).to_contain_text('正在加载邮件')
        page.keyboard.press('Escape')
        page.locator('.accepted-candidate').filter(has_text='回归测试计划').get_by_role('button',name='查看邮件',exact=True).click()
        expect(dialog).to_contain_text('核对邮件1')
        page.evaluate('window.__finishReply()')
        expect(dialog).not_to_contain_text('核对邮件3')
        dialog.get_by_role('button',name='关闭',exact=True).last.click()
        page.evaluate('window.__missingReply=true')
        candidate.get_by_role('button',name='查看邮件',exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('对应邮件已不存在')
        page.evaluate('window.__missingReply=false')
        dialog.get_by_role('button',name='重试',exact=True).click()
        expect(dialog).to_contain_text('核对邮件3')
        page.set_viewport_size({'width':720,'height':560})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        dialog.get_by_role('button',name='关闭',exact=True).last.click()
        # Errors preserve the candidate; a successful single click needs no confirmation/form.
        page.evaluate('window.__failDismiss=true')
        candidate.get_by_role('button',name='误判',exact=True).click()
        expect(page.get_by_text('标记误判失败：Error: fixture 保存失败',exact=True)).to_be_visible()
        expect(candidate).to_be_visible()
        page.evaluate('window.__failDismiss=false;window.__slowDismiss=true')
        candidate.get_by_role('button',name='误判',exact=True).click()
        expect(candidate.get_by_role('button',name='处理中…')).to_be_disabled()
        expect(page.get_by_role('dialog')).to_have_count(0)
        expect(page.get_by_role('alertdialog')).to_have_count(0)
        page.evaluate('window.__finishDismiss()')
        expect(candidate).to_have_count(0)
        expect(page.get_by_text('已记住这类误判回复，相同正文将不再提示过稿，原邮件已保留',exact=True)).to_be_visible()
        assert page.evaluate('window.__acceptedWorks.length')==0
        assert page.evaluate("window.__calls.filter(c=>c.name==='dismissAcceptedCandidate').map(c=>c.args)")==[[3,3],[3,3]]
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: exact candidate mail, offline text, no confirmation side effects, stale/closed responses, missing mail retry, narrow layout')

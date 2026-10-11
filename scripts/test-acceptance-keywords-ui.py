"""Editable acceptance keywords, safe save/retry and explicit history refresh. Mock-only."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA=r'''
window.__settings={...functions.getSettings(),acceptance_body_keywords:['审核通过','过稿','录用']};
functions.updateSettings=settings=>{
 if(window.__failRuleSave)throw new Error('fixture 规则保存失败');
 window.__settings=settings;
};
functions.reclassifyReplies=()=>2;
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='收件箱',exact=True).click()
        rulebar=page.get_by_role('group',name='过稿统计识别规则')
        expect(rulebar).to_contain_text('审核通过')
        rulebar.get_by_role('button',name='编辑过稿关键词',exact=True).click()
        dialog=page.get_by_role('dialog',name='过稿统计识别关键词',exact=True)
        field=dialog.get_by_role('textbox',name='过稿回复正文关键词')
        expect(field).to_have_value('审核通过\n过稿\n录用')
        field.fill('\n签约邀请\nReady to Contract\nready to contract\n')
        page.evaluate('window.__settings.reply_poll_minutes=7;window.__failRuleSave=true')
        dialog.get_by_role('button',name='保存规则',exact=True).click()
        expect(page.locator('.toasts')).to_contain_text('fixture 规则保存失败')
        expect(dialog).to_be_visible()
        assert page.evaluate('window.__settings.acceptance_body_keywords')==['审核通过','过稿','录用']
        page.evaluate('window.__failRuleSave=false')
        dialog.get_by_role('button',name='保存规则',exact=True).click()
        expect(dialog).to_have_count(0)
        expect(rulebar.locator('.inbox-rule-keywords > span')).to_have_count(2)
        assert page.evaluate('window.__settings.acceptance_body_keywords')==['签约邀请','Ready to Contract']
        assert page.evaluate('window.__settings.reply_poll_minutes')==7
        assert not page.evaluate("window.__calls.some(c=>c.name==='reclassifyReplies')")
        # Updating automatic rules preserves the acceptance configuration.
        page.get_by_role('group',name='自动回复识别规则').get_by_role('button',name='编辑关键词',exact=True).click()
        auto=page.get_by_role('dialog',name='自动回复识别关键词',exact=True)
        auto.get_by_role('textbox',name='自动回复主题关键词').fill('Receipt')
        auto.get_by_role('button',name='保存规则',exact=True).click()
        expect(auto).to_have_count(0)
        assert page.evaluate('window.__settings.acceptance_body_keywords')==['签约邀请','Ready to Contract']
        # Boundary errors keep the dialog and prior settings intact.
        rulebar.get_by_role('button',name='编辑过稿关键词',exact=True).click()
        field.fill('\n'.join(f'关键词{i}' for i in range(31)))
        dialog.get_by_role('button',name='保存规则',exact=True).click()
        expect(dialog).to_be_visible()
        expect(page.locator('.toasts')).to_contain_text('最多 30 个关键词')
        field.fill('')
        dialog.get_by_role('button',name='保存规则',exact=True).click()
        expect(dialog).to_have_count(0)
        expect(rulebar).to_contain_text('未设置关键词')
        assert page.evaluate('window.__settings.acceptance_body_keywords')==[]
        assert page.evaluate('window.__settings.auto_reply_subject_keywords')==['Receipt']
        page.get_by_role('button',name='按当前规则重新判定',exact=True).click()
        expect(page.locator('.toasts')).to_contain_text('已按当前规则重新判定 2 封回复')
        page.set_viewport_size({'width':720,'height':560})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not page.evaluate("window.__calls.some(c=>['startTask','sendManualDelivery','resendDelivery','scanReplies'].includes(c.name))")
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: independent acceptance rules, dedup/save retry, settings preservation, empty disable, validation and explicit reclassification')

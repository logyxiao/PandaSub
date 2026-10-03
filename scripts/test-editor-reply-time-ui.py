"""Derived editor reply time rendering and refresh, mock-only browser regression."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
const baseEditor=functions.listEditors()[0];
window.__replySeconds=14400;
functions.listEditors=()=>[
 {...baseEditor,average_reply_seconds:window.__replySeconds,reply_sample_count:2},
 {...baseEditor,id:2,name:'暂无回复编辑',email:'none@example.com',average_reply_seconds:null,reply_sample_count:0},
 {...baseEditor,id:3,name:'跨天编辑',email:'days@example.com',average_reply_seconds:183600,reply_sample_count:3},
 {...baseEditor,id:4,name:'快速回复编辑',email:'fast@example.com',average_reply_seconds:0,reply_sample_count:1},
];
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='编辑库',exact=True).click()
        table=page.locator('.library-table')
        expect(table.get_by_role('columnheader',name='平均回复时间',exact=True)).to_be_visible()
        row=table.get_by_role('row').filter(has=page.get_by_role('button',name='编辑甲',exact=True))
        expect(row.locator('.editor-reply-time')).to_have_text('4 小时基于 2 次投递')
        expect(table.get_by_role('row').filter(has_text='暂无回复编辑').locator('.editor-reply-time')).to_have_text('暂无数据暂无有效人工回复')
        expect(table.get_by_role('row').filter(has_text='跨天编辑').locator('.editor-reply-time')).to_have_text('2 天 3 小时基于 3 次投递')
        expect(table.get_by_role('row').filter(has_text='快速回复编辑').locator('.editor-reply-time')).to_have_text('不足 1 分钟基于 1 次投递')
        page.evaluate("window.__replySeconds=18000;window.__emit('reply',{})")
        expect(row.locator('.editor-reply-time')).to_have_text('5 小时基于 2 次投递')
        # Refresh must defer while a quick-edit draft is dirty.
        row.locator('.library-email').dblclick()
        email=page.get_by_role('textbox',name='修改投稿邮箱',exact=True)
        email.fill('unsaved@example.com')
        page.evaluate("window.__replySeconds=21600;window.__emit('reply',{})")
        page.wait_for_timeout(450)
        expect(email).to_have_value('unsaved@example.com')
        email.press('Escape')
        expect(row.locator('.editor-reply-time')).to_have_text('6 小时基于 2 次投递')
        for width,height in [(1280,900),(720,560)]:
            page.set_viewport_size({'width':width,'height':height})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path=f'/tmp/novelsub-editor-reply-time-{engine}.png')
        assert not errors,errors
        assert not page.evaluate("window.__calls.some(c=>['sendManualDelivery','resendDelivery','updateEditor'].includes(c.name))")
        browser.close()
        print(f'PASS {engine}: reply duration, samples, empty/zero states, event refresh, draft preservation and narrow layout')

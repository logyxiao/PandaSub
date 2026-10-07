"""Per-thousand pricing: mock-only Chromium/WebKit regression."""
import os
from playwright.sync_api import expect, sync_playwright
from ui_fixtures import MOCK, UPDATE
from accepted_ui_fixtures import ACCEPTED

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width': 1180, 'height': 850})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK + ACCEPTED + '\nm.word_count=10000;'))
        page.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.get_by_role('navigation', name='主导航').get_by_role('button', name='过稿统计').click()
        page.locator('.accepted-candidate').filter(has_text='回归测试计划').get_by_role('button', name='最终过稿').click()
        dialog = page.get_by_role('dialog', name='核对作品结果')
        dialog.get_by_role('button', name='保底加分成').click()
        expect(dialog.get_by_label('总字数（字）', exact=True)).to_have_value('10000')
        expect(dialog.get_by_label('总字数（字）', exact=True)).to_have_attribute('readonly', '')
        dialog.get_by_label('千字单价（元）').fill('30')
        expect(dialog.get_by_role('status', name='千字计价收益预览')).to_contain_text('计入总收益：¥300')
        dialog.get_by_role('button', name='保存最终过稿记录').click()
        expect(page.locator('.accepted-summary > div').last).to_contain_text('¥300')
        assert page.evaluate('window.__acceptedWorks[0].word_count') == 10000

        page.get_by_role('button', name='新增外部文章').first.click()
        dialog.get_by_label('作品名称').fill('外部千字计价文章')
        dialog.get_by_role('button', name='保底加分成').click()
        dialog.get_by_label('千字单价（元）').fill('30')
        dialog.get_by_role('button', name='保存最终过稿记录').click()
        expect(page.get_by_text('请填写总字数，以计算千字计价收入', exact=True)).to_be_visible()
        assert page.evaluate('window.__acceptedWorks.length') == 1
        dialog.get_by_label('总字数（字）', exact=True).fill('12345')
        preview = dialog.get_by_role('status', name='千字计价收益预览')
        expect(preview).to_contain_text('计入总收益：¥370.35')
        dialog.get_by_label('保底总价（元）').fill('500')
        expect(preview).to_contain_text('计入总收益：¥500')
        dialog.get_by_label('保底总价（元）').fill('')
        dialog.get_by_label('已结算分成（元）').fill('20')
        expect(preview).to_contain_text('计入总收益：¥390.35')
        preview.scroll_into_view_if_needed()
        page.screenshot(path=f'/tmp/novelsub-accepted-word-count-{engine}.png')
        dialog.get_by_role('button', name='保存最终过稿记录').click()
        expect(page.locator('.accepted-summary > div').last).to_contain_text('¥690.35')
        assert page.evaluate('window.__acceptedWorks[1].word_count') == 12345
        page.locator('.accepted-table tbody tr').filter(has_text='外部千字计价文章').get_by_role('button', name='编辑').click()
        dialog = page.get_by_role('dialog', name='编辑核对记录 · 外部千字计价文章')
        expect(dialog.get_by_label('总字数（字）', exact=True)).to_have_value('12345')
        dialog.get_by_label('总字数（字）', exact=True).fill('20000')
        expect(dialog.get_by_role('status', name='千字计价收益预览')).to_contain_text('计入总收益：¥620')
        dialog.get_by_role('button', name='保存最终过稿记录').click()
        expect(page.locator('.accepted-summary > div').last).to_contain_text('¥920')
        assert not errors, errors
        browser.close()
        print(f'PASS: {engine} linked count, external count, missing-count guard, calculated total, manual override and edit persistence')

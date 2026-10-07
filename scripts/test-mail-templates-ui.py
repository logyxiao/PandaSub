"""Twenty friendly templates, preview/fixed choice, and persistent customization; mock IPC only."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
import catalog from '/src/data/mail-template-catalog.json';
let defaults=catalog.presets.map(item=>({...item}));
functions.getDefaultMailTemplates=()=>defaults.map(item=>({...item}));
functions.saveDefaultMailTemplates=items=>{defaults=items.map(item=>({...item}))};
'''

with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1100})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.route('**/src/api.ts*',lambda route:route.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda route:route.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='投稿计划',exact=True).click()
        page.get_by_role('button',name='新建计划',exact=True).click()
        page.get_by_label('作品名称',exact=True).fill('小熊来信')
        tabs=page.get_by_role('tablist',name='邮件模板').get_by_role('tab')
        expect(tabs).to_have_count(20)
        expect(page.locator('.plan-tpl-strategy')).to_contain_text('从 20 套模板中随机选用')
        for tab in tabs.all():
            tab.click()
            preview=page.locator('.plan-tpl-preview-body')
            expect(preview).to_contain_text('小熊来信')
            assert '编辑甲' not in preview.inner_text()
            assert '{{' not in preview.inner_text()
        strategy=page.locator('.plan-tpl-strategy select')
        strategy.select_option('t22')
        expect(tabs.filter(has_text='好心情收尾')).to_have_attribute('aria-selected','true')
        expect(page.locator('.plan-tpl-strategy')).to_contain_text('每封邮件使用同一套模板')
        page.screenshot(path=f'/tmp/novelsub-twenty-templates-{engine}.png')
        page.set_viewport_size({'width':720,'height':800})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        tabs.first.click()
        expect(tabs.first).to_have_attribute('aria-selected','true')
        page.set_viewport_size({'width':1440,'height':1100})
        # Removing a template is still honored on the next new plan.
        page.get_by_role('button',name='删除',exact=True).click()
        expect(tabs).to_have_count(19)
        page.get_by_role('button',name='返回',exact=True).click()
        page.get_by_role('button',name='放弃修改',exact=True).click()
        page.get_by_role('button',name='新建计划',exact=True).click()
        expect(tabs).to_have_count(19)
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: 20 templates, readable previews, no editor names, fixed choice, narrow layout and saved deletion')

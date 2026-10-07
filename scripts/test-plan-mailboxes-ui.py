"""Plan list sender history/configuration and live refresh; no real mail or database."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
accounts[0].sender_name='小熊';
accounts[0].notes='短篇专用\n'+ '长备注内容。'.repeat(90)+'备注末尾';
accounts.push({...accounts[0],id:2,email:'backup@example.com',sender_name:'',notes:'海外备用',enabled:false});
const plans=[
 {...m,id:1,title:'实际使用两个邮箱',account_ids:[3],sent_account_ids:[1,2]},
 {...m,id:2,title:'草稿已选邮箱',account_ids:[1],sent_account_ids:[]},
 {...m,id:3,title:'草稿未选邮箱',account_ids:[],sent_account_ids:[]},
 {...m,id:4,title:'历史邮箱已删除',account_ids:[],sent_account_ids:[99,null]},
 {...m,id:5,title:'任务使用独立配置',account_ids:[1],sent_account_ids:[]},
 {...m,id:6,title:'旧计划全部启用',account_ids:[],sent_account_ids:[]},
];
window.__plans=plans;
functions.listManuscripts=()=>plans.map(plan=>({...plan}));
functions.listTasks=()=>[
 {...task,id:1,manuscript_ids:[1],account_ids:[3],status:'completed'},
 {...task,id:5,manuscript_ids:[5],account_ids:[2]},
 {...task,id:6,manuscript_ids:[6],account_ids:[]},
];
'''

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width':1440, 'height':1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK+EXTRA))
        page.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        page.get_by_role('navigation', name='主导航').get_by_role('button', name='投稿计划', exact=True).click()
        table = page.locator('.plans-table')
        expect(table.get_by_role('columnheader', name='投稿邮箱', exact=True)).to_be_visible()
        def senders(title):
            return table.get_by_role('row').filter(has_text=title).locator('.plan-mailboxes-cell')
        used = senders('实际使用两个邮箱')
        expect(used).not_to_contain_text('已使用')
        expect(used).not_to_contain_text('已配置')
        expect(used).to_contain_text('小熊')
        expect(used).not_to_contain_text('fixture@example.com')
        expect(used).to_contain_text('backup@example.com')
        expect(used).not_to_contain_text('短篇专用')
        expect(used).not_to_contain_text('#3')
        expect(senders('草稿已选邮箱')).to_have_text('小熊')
        expect(senders('草稿未选邮箱')).to_have_text('未选择邮箱')
        expect(senders('历史邮箱已删除')).to_contain_text('邮箱已删除（#99）')
        expect(senders('历史邮箱已删除')).to_contain_text('历史邮箱信息缺失')
        expect(senders('任务使用独立配置')).to_contain_text('backup@example.com')
        expect(senders('任务使用独立配置')).not_to_contain_text('fixture@example.com')
        expect(senders('旧计划全部启用')).to_contain_text('小熊')
        expect(senders('旧计划全部启用')).not_to_contain_text('backup@example.com')
        # Full metadata lives in a hover/focus popup; long notes remain scrollable.
        author = used.get_by_role('button',name='小熊',exact=True)
        author.hover()
        tooltip = page.get_by_role('tooltip')
        expect(tooltip).to_be_visible()
        expect(tooltip).to_contain_text('笔名：小熊')
        expect(tooltip).to_contain_text('邮箱：fixture@example.com')
        expect(tooltip).to_contain_text('类型：QQ 邮箱')
        expect(tooltip).to_contain_text('今日发送：1 封')
        expect(tooltip).to_contain_text('备注：短篇专用')
        expect(tooltip).to_contain_text('备注末尾')
        tooltip.hover()
        expect(tooltip).to_be_visible()
        assert tooltip.evaluate('e=>e.scrollHeight>e.clientHeight')
        page.screenshot(path=f'/tmp/novelsub-plan-mailboxes-{engine}.png')
        page.keyboard.press('Escape')
        expect(tooltip).to_have_count(0)
        author.focus()
        expect(tooltip).to_be_visible()
        page.keyboard.press('Escape')
        used.get_by_role('button',name='backup@example.com',exact=True).hover()
        expect(tooltip).to_contain_text('笔名：未填写')
        expect(tooltip).to_contain_text('状态：已停用')
        expect(tooltip).to_contain_text('备注：海外备用')
        page.keyboard.press('Escape')
        # A successful delivery refreshes the list's aggregated sender history.
        page.evaluate("window.__plans[1].sent_account_ids=[2];window.__emit('log',{category:'send',level:'success',manuscript_id:2})")
        expect(senders('草稿已选邮箱')).not_to_contain_text('已使用')
        expect(senders('草稿已选邮箱')).to_contain_text('backup@example.com')
        expect(senders('草稿已选邮箱')).not_to_contain_text('小熊')
        for width in [1280,720]:
            page.mouse.move(1, 1)
            page.set_viewport_size({'width':width,'height':800})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert used.evaluate('e=>e.scrollWidth<=e.clientWidth')
            author.hover()
            expect(tooltip).to_be_visible()
            box = tooltip.bounding_box()
            assert box['x']>=0 and box['x']+box['width']<=width
            page.keyboard.press('Escape')
        assert not page.evaluate("window.__calls.some(c=>c.name==='listDeliveries')")
        assert not errors, errors
        browser.close()
        print(f'PASS {engine}: pen names, email fallback, full hover/focus details, long notes, Escape, sender history and responsive layout')

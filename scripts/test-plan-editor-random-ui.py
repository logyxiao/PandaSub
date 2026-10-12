"""Type matching/history priority/manual stability with isolated browser fixtures; no SMTP."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base=functions.listEditors()[0];
const make=(id,name,platform,extra={})=>({...base,id,name,platform,email:`e${id}@example.com`,work_type:['短篇','悬疑'],favorited:false,plan_sent_count:0,plan_queued_count:0,...extra});
const editors=[
 make(1,'甲已投收藏','甲',{favorited:true,plan_sent_count:5}),
 make(2,'甲未投普通','甲'),make(3,'甲排队收藏','甲',{favorited:true,plan_queued_count:1}),
 make(4,'乙收藏A','乙',{favorited:true}),make(5,'乙收藏B','乙',{favorited:true}),make(6,'乙普通','乙'),
 make(7,'丙低使用','丙',{plan_sent_count:2}),make(8,'丙排队','丙',{plan_sent_count:2,plan_queued_count:1}),
 make(9,'丙高使用收藏','丙',{plan_sent_count:4,favorited:true}),
 make(10,'丁A','丁'),make(11,'丁B','丁'),
 make(12,'停用','甲',{enabled:false,favorited:true}),make(13,'无效邮箱','甲',{email:'invalid',favorited:true}),
 make(14,'错误类型','甲',{work_type:['长篇','甜宠'],favorited:true}),make(15,'拒收悬疑','甲',{rejected_types:['悬疑'],favorited:true})
];
task.status='stopped';m.recipients=[];m.genres=['短篇','悬疑'];
functions.listEditors=()=>editors.map(e=>({...e}));functions.listEditorGroups=()=>[];
functions.updateManuscript=(id,input)=>{window.__savedRecipients=input.recipients;Object.assign(m,input)};
'''

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser=getattr(p,engine).launch()
        page=browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        page.evaluate('Math.random=()=>0.999')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='投稿计划',exact=True).click()
        page.get_by_role('button',name='编辑计划',exact=True).click()
        page.evaluate('Math.random=()=>0.999')
        page.get_by_role('button',name='下一步：选择编辑',exact=True).click()
        for name in ['甲未投普通','乙收藏B','丙低使用','丁B']:
            expect(page.get_by_role('checkbox',name='取消选择 '+name,exact=True)).to_be_checked()
        # Explicitly switching a platform peer must override the automated preference.
        page.get_by_role('row').filter(has_text='甲未投普通').get_by_title('更换同平台编辑',exact=True).click()
        page.get_by_role('option').filter(has_text='甲已投收藏').click()
        expect(page.get_by_role('checkbox',name='取消选择 甲已投收藏',exact=True)).to_be_checked()
        page.evaluate('Math.random=()=>0')
        page.get_by_role('button',name='下一步：选择邮箱',exact=True).click()
        page.get_by_role('button',name='上一步',exact=True).click()
        expect(page.get_by_role('checkbox',name='取消选择 甲已投收藏',exact=True)).to_be_checked()
        expect(page.get_by_role('checkbox',name='取消选择 丁B',exact=True)).to_be_checked()
        # Bulk deselect/reselect needs all platform peers, not just the preview row.
        actions=page.get_by_role('group',name='批量选择当前筛选结果')
        actions.get_by_role('button',name='取消全选',exact=True).click()
        actions.get_by_role('button',name='全选',exact=True).click()
        expect(page.get_by_role('checkbox',name='取消选择 甲未投普通',exact=True)).to_be_checked()
        expect(page.get_by_role('checkbox',name='取消选择 乙收藏A',exact=True)).to_be_checked()
        expect(page.get_by_role('checkbox',name='取消选择 丁A',exact=True)).to_be_checked()
        page.get_by_role('button',name='保存草稿',exact=True).click()
        page.wait_for_function('Array.isArray(window.__savedRecipients)')
        saved=page.evaluate('window.__savedRecipients')
        assert len(saved)==4,saved
        page.evaluate('Math.random=()=>0.999')
        page.get_by_role('button',name='编辑计划',exact=True).click()
        page.get_by_role('button',name='下一步：选择编辑',exact=True).click()
        expect(page.get_by_role('checkbox',name='取消选择 丁A',exact=True)).to_be_checked()
        page.get_by_role('button',name='保存草稿',exact=True).click()
        expect(page.get_by_role('button',name='编辑计划',exact=True)).to_be_visible()
        assert page.evaluate('window.__savedRecipients')==saved,(saved,page.evaluate('window.__savedRecipients'))
        assert not page.evaluate("window.__calls.some(c=>['startTask','resumeTask','sendManualDelivery','resendDelivery'].includes(c.name))")
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: genuine type-match draw, history/queue/favorite priority, manual retention, full bulk pool and saved roster stability')

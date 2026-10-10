"""Group picks and temporary adjustments deduplicate platforms without sending mail."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base=functions.listEditors()[0];
const editors=[
 {...base,id:1,name:'甲普通',platform:'平台甲',email:'a@example.com'},
 {...base,id:2,name:'甲收藏',platform:'平台甲',email:'fav@example.com',favorited:true},
 {...base,id:3,name:'乙编辑',platform:'平台乙',email:'b@example.com'},
 {...base,id:4,name:'乙停用',platform:'平台乙',email:'disabled@example.com',enabled:false},
 {...base,id:5,name:'丙无效',platform:'平台丙',email:'invalid'},
 {...base,id:6,name:'丙有效',platform:'平台丙',email:'c@example.com'},
 {...base,id:7,name:'未填一',platform:'',email:'unknown1@example.com'},
 {...base,id:8,name:'未填二',platform:'',email:'unknown2@example.com'},
 {...base,id:9,name:'甲收藏二',platform:'平台甲',email:'fav2@example.com',favorited:true},
 {...base,id:10,name:'乙编辑二',platform:'平台乙',email:'b2@example.com'},
];
const groups=[{id:1,name:'女频',editor_ids:[1,2,2,3,4,5,6,7,8,9,10]}];
window.__groups=groups;
task.status='stopped';m.recipients=editors.map(e=>e.email);
functions.listEditors=()=>editors.map(e=>({...e}));
functions.listEditorGroups=()=>groups.map(g=>({...g,editor_ids:[...g.editor_ids]}));
functions.updateManuscript=(id,input)=>{window.__savedRecipients=input.recipients;window.__savedLock=input.lock_recipients;Object.assign(m,input)};
functions.createEditorGroup=input=>{const id=groups.length+1;groups.push({...input,id});return id};
'''

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width':1280, 'height':900}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK+EXTRA))
        page.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        original_group = page.evaluate('window.__groups[0].editor_ids')
        page.get_by_role('navigation', name='主导航').get_by_role('button', name='投稿计划', exact=True).click()
        page.get_by_role('button', name='编辑计划', exact=True).click()
        page.get_by_role('button', name='下一步：选择编辑', exact=True).click()
        roster = page.locator('.plan-group-roster')
        expect(roster).to_contain_text('这次将投给 5 位')
        expect(roster).to_contain_text('甲收藏')
        expect(roster).not_to_contain_text('甲普通')
        # Fresh group clicks follow the same rule as restoring an older plan.
        radio = page.get_by_role('radio').filter(has_text='女频')
        radio.click()
        expect(roster).to_have_count(0)
        page.evaluate('Math.random=()=>0')
        radio.click()
        expect(roster).to_contain_text('这次将投给 5 位')
        expect(roster).not_to_contain_text('甲收藏二')
        expect(roster).not_to_contain_text('乙编辑二')
        radio.click()
        page.evaluate('Math.random=()=>0.999')
        radio.click()
        expect(roster).to_contain_text('甲收藏二')
        expect(roster).to_contain_text('乙编辑二')
        # Changing random values, visiting the send step and rerendering cannot redraw.
        page.evaluate('Math.random=()=>0')
        page.get_by_role('button', name='下一步：选择邮箱', exact=True).click()
        expect(page.locator('.plan-send-review')).to_contain_text('本次名单已固定')
        page.get_by_role('button', name='上一步', exact=True).click()
        expect(roster).to_contain_text('甲收藏二')
        expect(roster).to_contain_text('乙编辑二')
        page.get_by_role('button', name='调整名单', exact=True).click()
        dialog = page.get_by_role('dialog', name='调整这次名单', exact=True)
        chosen = dialog.get_by_role('region', name='已选成员', exact=True)
        expect(chosen.locator('.group-member-row')).to_have_count(5)
        dialog.locator('button[data-editor-id="1"]').click()
        expect(chosen.locator('button[data-editor-id="1"]')).to_have_count(1)
        expect(chosen.locator('button[data-editor-id="2"]')).to_have_count(0)
        expect(chosen.locator('.group-member-row')).to_have_count(5)
        dialog.get_by_role('button', name='加入筛选', exact=True).click()
        expect(chosen.locator('.group-member-row')).to_have_count(5)
        expect(chosen.locator('button[data-editor-id="2"]')).to_have_count(1)
        expect(chosen.locator('button[data-editor-id="4"]')).to_have_count(0)
        expect(chosen.locator('button[data-editor-id="5"]')).to_have_count(0)
        dialog.get_by_role('button', name='用于这次计划', exact=True).click()
        expect(roster).to_contain_text('这次将投给 5 位')
        # Creating a group may retain all peers; using it for this plan still picks one per platform.
        page.get_by_role('button', name='新建编辑组', exact=True).click()
        new_group = page.get_by_role('dialog', name='新建编辑组', exact=True)
        new_group.get_by_role('textbox', name='编辑组名称', exact=True).fill('全部成员组')
        new_group.get_by_role('button', name='加入筛选', exact=True).click()
        expect(new_group.get_by_role('region', name='已选成员').locator('.group-member-row')).to_have_count(10)
        page.evaluate('Math.random=()=>0.999')
        new_group.get_by_role('button', name='保存', exact=True).click()
        expect(roster).to_contain_text('这次将投给 5 位')
        expect(roster).to_contain_text('甲收藏二')
        expect(roster).to_contain_text('乙编辑二')
        assert len(page.evaluate('window.__groups[1].editor_ids')) == 10
        assert page.evaluate('window.__groups[0].editor_ids') == original_group
        page.get_by_role('button', name='保存草稿', exact=True).click()
        page.wait_for_function('Array.isArray(window.__savedRecipients)')
        saved = page.evaluate('window.__savedRecipients')
        emails = [r.split('<')[-1].rstrip('>').strip().lower() for r in saved]
        assert set(emails) == {'fav2@example.com','b2@example.com','c@example.com','unknown1@example.com','unknown2@example.com'}, saved
        assert len(saved) == 5
        assert page.evaluate('window.__savedLock') is True
        # Opening and saving the draft again must preserve the previous draw and lock.
        page.evaluate('Math.random=()=>0')
        page.get_by_role('button', name='编辑计划', exact=True).click()
        page.get_by_role('button', name='下一步：选择编辑', exact=True).click()
        page.get_by_role('button', name='保存草稿', exact=True).click()
        expect(page.get_by_role('button', name='编辑计划', exact=True)).to_be_visible()
        assert page.evaluate('window.__savedRecipients') == saved, (saved, page.evaluate('window.__savedRecipients'))
        assert page.evaluate('window.__savedLock') is True
        assert not page.evaluate("window.__calls.some(c=>['startTask','sendManualDelivery','updateEditorGroup'].includes(c.name))")
        assert not errors, errors
        browser.close()
        print(f'PASS {engine}: restored/fresh/new groups, favorite picks, peer replacement, bulk additions, saved recipients and immutable source group')

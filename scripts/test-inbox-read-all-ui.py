"""Bulk read scope, partial failure, and empty group import; mock APIs only."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
accounts.push({...accounts[0],id:2,email:'second@example.com'});
replies.forEach((r,i)=>{r.account_id=i<205?1:2;r.is_read=false;r.read_synced=true;serverSeen.set(r.id,false)});
window.__replies=replies;
functions.markRepliesRead=async(kind,taskId,q,accountId)=>{
 const targets=functions.listRepliesPage(kind,taskId,q,10000,0,accountId).items.filter(r=>r.kind==='human'&&r.read_synced&&!r.is_read);
 if(window.__slowBulk){window.__slowBulk=false;await new Promise(resolve=>window.__finishBulk=resolve)}
 if(window.__failBulk)throw new Error('fixture offline');
 const states=[];let failed=0;
 for(const r of targets){
  if(window.__partialBulk&&r.account_id===2){failed++;continue}
  functions.setReplyRead(r.id,true);states.push({id:r.id,is_read:true,read_synced:true});
 }
 return{states,failed,errors:failed?[{account_id:2,email:'second@example.com',message:'offline'}]:[]};
};
let groups=[];
functions.listEditorGroups=()=>groups.map(g=>({...g}));
functions.importEditorGroups=async(data,name)=>{
 window.__importPayload={data:Array.from(data),name};
 if(window.__badImport)throw new Error('fixture invalid group file');
 groups=[{id:1,name:'导入的编辑组',editor_ids:[1]}];
 return{groups_added:1,groups_updated:0,editors_added:0};
};
'''

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        page = browser.new_page(viewport={'width':1280, 'height':900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK+EXTRA))
        page.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL'])
        page.wait_for_load_state('networkidle')
        nav = page.get_by_role('navigation', name='主导航')
        inbox = nav.get_by_role('button', name='收件箱', exact=True)
        inbox.click()
        bulk = page.get_by_role('button', name='一键已读', exact=True)
        expect(bulk).to_be_enabled()
        # Account scope covers 205 matching rows, not just the visible page.
        nav.get_by_role('button', name='fixture@example.com', exact=True).click()
        expect(bulk).to_be_enabled()
        page.evaluate('window.__slowBulk=true')
        bulk.click()
        expect(page.get_by_role('button', name='正在标记…')).to_be_disabled()
        page.evaluate('window.__finishBulk()')
        expect(page.get_by_text('已将 205 封邮件标为已读', exact=True)).to_be_visible()
        expect(inbox).to_have_attribute('title', '收件箱 · 100 封未读人工回复')
        assert page.evaluate('window.__replies.filter(r=>r.account_id===1&&!r.is_read).length') == 0
        assert page.evaluate("window.__calls.filter(c=>c.name==='markRepliesRead').length") == 1
        expect(bulk).to_be_enabled()
        bulk.click()
        expect(page.get_by_text('当前筛选下没有未读邮件', exact=True)).to_be_visible()
        # Search for one old message in the other account.
        nav.get_by_role('button', name='全部账号', exact=True).click()
        search = page.get_by_placeholder('搜索邮件、编辑或邮箱')
        search.fill('最早的历史回复')
        expect(page.locator('.reply-list-item')).to_have_count(1)
        expect(bulk).to_be_enabled()
        bulk.click()
        expect(page.get_by_text('已将 1 封邮件标为已读', exact=True)).to_be_visible()
        search.fill('')
        page.get_by_role('button', name='按类型筛选', exact=True).click()
        page.get_by_role('option', name='未读人工回复', exact=True).click()
        expect(page.locator('.reply-list-item')).to_have_count(20)
        page.evaluate('window.__partialBulk=true')
        bulk.click()
        expect(page.get_by_text('已标记 0 封，99 封未完成，请刷新后重试', exact=True)).to_be_visible()
        expect(inbox).to_have_attribute('title', '收件箱 · 99 封未读人工回复')
        page.evaluate('window.__partialBulk=false;window.__failBulk=true')
        expect(bulk).to_be_enabled()
        bulk.click()
        expect(page.get_by_text('一键已读失败：Error: fixture offline', exact=True)).to_be_visible()
        page.evaluate('window.__failBulk=false')
        expect(bulk).to_be_enabled()
        bulk.click()
        expect(page.get_by_text('已将 99 封邮件标为已读', exact=True)).to_be_visible()
        expect(page.locator('.reply-list-item')).to_have_count(0)
        expect(inbox.locator('.nav-unread-badge')).to_have_count(0)
        expect(bulk).to_be_disabled()
        # Import is reachable before any group exists, including after a failed import.
        nav.get_by_role('button', name='编辑组', exact=True).click()
        expect(page.get_by_text('还没有编辑组', exact=True)).to_be_visible()
        import_button = page.get_by_role('button', name='导入', exact=True)
        expect(import_button).to_be_visible()
        page.screenshot(path=f'/tmp/novelsub-empty-groups-{engine}.png')
        payload = {'name':'editors.json', 'mimeType':'application/json', 'buffer':b'{"groups":[]}'}
        page.evaluate('window.__badImport=true')
        with page.expect_file_chooser() as chooser:
            import_button.click()
        chooser.value.set_files(payload)
        expect(page.get_by_text('Error: fixture invalid group file', exact=True)).to_be_visible()
        expect(import_button).to_be_enabled()
        page.evaluate('window.__badImport=false')
        with page.expect_file_chooser() as chooser:
            import_button.click()
        chooser.value.set_files(payload)
        expect(page.get_by_role('tab', name='导入的编辑组', exact=False)).to_be_visible()
        expect(page.get_by_text('还没有编辑组', exact=True)).to_have_count(0)
        assert page.evaluate('window.__importPayload.name') == 'editors.json'
        assert not page.evaluate("window.__calls.some(c=>c.name==='createEditorGroup')")
        assert not errors, errors
        browser.close()
        print(f'PASS {engine}: all pages, account/search scope, failure/retry, unread badge, empty group import')

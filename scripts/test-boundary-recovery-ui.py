"""Update/unsaved guards, committed task retries, and partial multi-account FLAGS failures.
All mail, updater, restart and persistence operations are isolated mocks.
"""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []

    def page(extra='', update=UPDATE):
        s = browser.new_page(viewport={'width': 1280, 'height': 850})
        s.clock.install()
        s.on('pageerror', lambda error: errors.append(str(error)))
        s.route('**/src/api.ts*', lambda r: r.fulfill(content_type='application/javascript', body=MOCK+extra))
        s.route('**/src/update.ts*', lambda r: r.fulfill(content_type='application/javascript', body=update))
        s.goto(os.environ['NOVELSUB_TEST_URL'])
        s.wait_for_load_state('networkidle')
        return s

    s = page(r'''
    const created=[];window.__createdTasks=created;
    functions.addManuscript=()=>100;functions.updateManuscript=()=>{};
    functions.createTask=input=>{
      const value={...task,...input,id:100+created.length,status:'stopped'};
      created.push(value);window.__failRefresh=true;
      return {id:value.id,start_error:'fixture task start failed'};
    };
    functions.listTasks=()=>{
      if(window.__failRefresh){window.__failRefresh=false;throw Error('fixture refresh failed')}
      return created.map(t=>({...t}));
    };
    let attempts=0;
    functions.updateTask=(id,input)=>{
      if(++attempts===1){window.__failRefresh=true;throw Error('fixture retry start failed')}
      const value=created.find(t=>t.id===id);Object.assign(value,input,{status:'running'});
    };
    ''')
    s.get_by_role('button', name='投稿计划', exact=True).click()
    s.get_by_role('button', name='新建计划', exact=True).click()
    s.get_by_label('作品名称', exact=True).fill('连续失败后重试')
    s.locator('.plan-desk input[type=file]').set_input_files({'name':'稿件.txt','mimeType':'text/plain','buffer':'有效文稿'.encode()})
    s.get_by_role('button', name='下一步：选择编辑').click()
    s.get_by_role('button', name='下一步：选择邮箱').click()
    s.get_by_role('button', name='开始发送', exact=True).click()
    expect(s.get_by_text('Error: fixture task start failed', exact=True)).to_be_visible()
    s.get_by_role('button', name='开始发送', exact=True).click()
    expect(s.get_by_text('Error: fixture retry start failed', exact=True)).to_be_visible()
    s.get_by_role('button', name='开始发送', exact=True).click()
    expect(s.locator('.plans-table')).to_be_visible()
    assert s.evaluate('window.__createdTasks.length') == 1
    assert s.evaluate("window.__calls.filter(c=>c.name==='addManuscript').length") == 1
    assert s.evaluate("window.__calls.filter(c=>c.name==='updateTask').map(c=>c.args[0])") == [100,100]
    print('PASS repeated startup + refresh failures reuse one persisted task and manuscript', flush=True)
    s.close()

    update = """export const currentVersion=async()=> '0.2.5';export const availableUpdate=async()=>({version:'99.0.0',close:async()=>{}});export const installUpdate=async()=>{};export const restartApp=async()=>{if(window.__failRestart)throw Error('fixture restart rejected');window.__restarts=(window.__restarts||0)+1};export const RELEASES_URL='';"""
    s = page(update=update)
    s.get_by_role('button', name='投稿计划', exact=True).click()
    s.get_by_role('button', name='新建计划', exact=True).click()
    s.get_by_label('作品名称', exact=True).fill('尚未保存的稿件')
    s.clock.fast_forward(5000)
    s.get_by_role('button', name='下载并安装', exact=True).click()
    s.get_by_role('button', name='立即重启', exact=True).click()
    guard = s.get_by_role('alertdialog', name='放弃未保存的修改？')
    expect(guard).to_be_visible()
    guard.get_by_role('button', name='继续编辑', exact=True).click()
    expect(s.get_by_label('作品名称', exact=True)).to_have_value('尚未保存的稿件')
    assert s.evaluate('window.__restarts||0') == 0
    # Navigate out, then ensure the installed-update button consults the new page's guard.
    s.get_by_role('button', name='返回', exact=True).click()
    guard.get_by_role('button', name='放弃修改', exact=True).click()
    s.get_by_role('button', name='设置', exact=True).click()
    s.get_by_role('button', name='发送', exact=True).click()
    s.get_by_role('spinbutton').fill('7')
    s.get_by_role('button', name='更新', exact=True).click()
    s.get_by_role('button', name='重启使用新版本', exact=True).click()
    expect(guard).to_be_visible()
    guard.get_by_role('button', name='继续编辑', exact=True).click()
    assert s.evaluate('window.__restarts||0') == 0
    s.get_by_role('button', name='发送', exact=True).click()
    expect(s.get_by_role('spinbutton')).to_have_value('7')
    s.get_by_role('button', name='更新', exact=True).click()
    s.evaluate('window.__failRestart=true')
    s.get_by_role('button', name='重启使用新版本', exact=True).click()
    guard.get_by_role('button', name='放弃修改', exact=True).click()
    expect(s.get_by_text('重启失败：Error: fixture restart rejected', exact=True)).to_be_visible()
    s.evaluate('window.__failRestart=false')
    s.get_by_role('button', name='重启使用新版本', exact=True).click()
    guard.get_by_role('button', name='放弃修改', exact=True).click()
    s.wait_for_function('window.__restarts===1')
    print('PASS automatic/manual update restart guards preserve drafts; failed relaunch can retry', flush=True)
    s.close()

    s = page(r'''
    replies.splice(2);replies.forEach((r,i)=>Object.assign(r,{id:i+1,account_id:i+1,subject:`邮箱${i+1}来信`,is_read:false,read_synced:true}));
    accounts.push({...accounts[0],id:2,email:'second@example.com'});
    functions.syncReplyReadFlags=ids=>{
      const states=[];const errors=[];
      for(const id of ids){
        const r=replies.find(r=>r.id===id);
        if(r.account_id===2&&!window.__recoverFlags){errors.push({account_id:2,email:'second@example.com',message:'fixture IMAP offline'});continue}
        r.is_read=true;r.read_synced=true;states.push({id,is_read:true,read_synced:true});
      }
      return {states,errors};
    };
    ''')
    s.get_by_role('button', name='收件箱', exact=True).click()
    rows = s.locator('.reply-list-item')
    expect(rows.filter(has_text='邮箱1来信')).to_have_class('reply-list-item is-read')
    expect(rows.filter(has_text='邮箱2来信')).to_have_class('reply-list-item is-unread')
    warning = s.get_by_role('status', name='已读状态同步提示')
    expect(warning).to_contain_text('second@example.com：fixture IMAP offline')
    s.evaluate('window.__recoverFlags=true')
    s.get_by_role('button', name='刷新列表', exact=True).click()
    expect(rows.filter(has_text='邮箱2来信')).to_have_class('reply-list-item is-read')
    expect(warning).to_have_count(0)
    print('PASS partial FLAGS success updates successful account, reports failure, and recovers on refresh', flush=True)
    s.close()
    assert not errors, errors
    browser.close()

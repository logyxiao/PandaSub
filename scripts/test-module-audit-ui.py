"""Regression cases from the module audit, using only isolated mocked APIs."""
import os,json,re
from ui_fixtures import MOCK,UPDATE
from playwright.sync_api import sync_playwright,expect
BASE=os.environ.get('NOVELSUB_UI_URL','http://127.0.0.1:5179')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 def page(extra=''):
  s=b.new_page(viewport={'width':1280,'height':850})
  s.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+extra))
  s.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
  s.goto(BASE);s.wait_for_load_state('networkidle');return s
 s=page()
 s.get_by_role('button',name='投稿计划',exact=True).click()
 s.get_by_role('button',name='新建计划',exact=True).click()
 s.get_by_label('作品名称',exact=True).fill('未保存的作品名称')
 s.get_by_role('button',name='返回',exact=True).click()
 s.get_by_role('button',name='继续编辑',exact=True).click()
 expect(s.get_by_label('作品名称',exact=True)).to_have_value('未保存的作品名称')
 s.get_by_role('button',name='返回',exact=True).click()
 s.get_by_role('button',name='放弃修改',exact=True).click()
 expect(s.locator('.plans-table')).to_be_visible()
 s.get_by_role('button',name='新建计划',exact=True).click()
 expect(s.get_by_label('作品名称',exact=True)).to_have_value('')
 print('PASS plan cancel/discard protection and clean wizard reopening',flush=True);s.close()
 s=page()
 s.get_by_role('button',name='设置',exact=True).click()
 s.get_by_role('button',name='发送',exact=True).click()
 field=s.get_by_label('发送失败后重试几次');expect(field).to_have_value('3');field.fill('7')
 s.get_by_role('button',name='工作台',exact=True).click()
 s.get_by_role('button',name='继续编辑',exact=True).click()
 expect(s.get_by_label('发送失败后重试几次')).to_have_value('7')
 s.get_by_role('button',name='工作台',exact=True).click()
 s.get_by_role('button',name='放弃修改',exact=True).click()
 s.get_by_role('button',name='设置',exact=True).click()
 s.get_by_role('button',name='发送',exact=True).click()
 expect(s.get_by_label('发送失败后重试几次')).to_have_value('3')
 print('PASS settings navigation protection',flush=True);s.close()
 s=page(r'''
 functions.addAccount=input=>{if(accounts.some(a=>a.email===input.email))throw new Error('UNIQUE constraint failed: accounts.email');if(input.email==='second@qq.com'&&!window.__allowSecond)throw new Error('fixture storage failure');accounts.push({...input,id:accounts.length+1});return accounts.length};
 window.__accounts=accounts;
 ''')
 s.get_by_role('button',name='邮箱管理',exact=True).click();s.get_by_role('button',name='添加邮箱',exact=True).first.click()
 d=s.get_by_role('dialog');d.get_by_label('邮箱地址').fill('first@qq.com');d.get_by_label('授权码',exact=True).fill('fixture')
 d.get_by_role('button',name='添加邮箱',exact=True).click()
 d.get_by_label('邮箱地址').nth(1).fill('second@qq.com');d.get_by_label('授权码',exact=True).nth(1).fill('fixture')
 d.get_by_role('button',name='保存配置').click()
 expect(s.get_by_text(re.compile('已添加 1 个邮箱，剩余项目可继续保存'))).to_be_visible()
 expect(d.get_by_label('邮箱地址')).to_have_count(1)
 expect(d.get_by_label('邮箱地址')).to_have_value('second@qq.com')
 s.evaluate('window.__allowSecond=true');d.get_by_role('button',name='保存配置').click()
 expect(d).to_have_count(0)
 assert s.evaluate("window.__accounts.filter(a=>a.email==='first@qq.com').length")==1
 assert s.evaluate("window.__accounts.some(a=>a.email==='second@qq.com')")==True
 print('PASS partial batch account save retries only remaining rows',flush=True);s.close()
 s=page(r'''
 const auditEditors=[1,2,3].map(id=>({id,email:`e${id}@example.com`,name:`编辑${id}`,platform:`平台${id}`,work_type:['短篇'],rejected_types:[],notes:'',enabled:true,favorited:false}));
 let auditGroup={id:1,name:'测试分组',editor_ids:[1,2,3]};window.__groupWrites=[];
 functions.listEditors=()=>auditEditors;functions.listEditorGroups=()=>[{...auditGroup}];
 functions.updateEditorGroup=(id,input)=>new Promise(resolve=>window.__groupWrites.push(()=>{auditGroup={...auditGroup,...input};resolve()}));
 ''')
 s.get_by_role('button',name='编辑组',exact=True).click()
 s.get_by_role('button',name='移出 编辑1',exact=True).click()
 expect(s.get_by_role('button',name='移出 编辑2',exact=True)).to_be_disabled()
 assert s.evaluate('window.__groupWrites.length')==1
 s.evaluate('window.__groupWrites[0]()')
 expect(s.get_by_role('button',name='移出 编辑1',exact=True)).to_have_count(0)
 s.get_by_role('button',name='移出 编辑2',exact=True).click()
 payload=s.evaluate("window.__calls.filter(c=>c.name==='updateEditorGroup').map(c=>c.args[1].editor_ids)")
 assert payload==[[2,3],[3]],payload
 s.evaluate('window.__groupWrites[1]()')
 expect(s.get_by_role('button',name='移出 编辑2',exact=True)).to_have_count(0)
 expect(s.get_by_role('button',name='移出 编辑1',exact=True)).to_have_count(0)
 print('PASS serialized group removal preserves both changes',flush=True);s.close()
 s=page()
 s.get_by_role('button',name='发送记录',exact=True).click();msg=s.locator('.log-msg').first;msg.click();expect(msg).to_have_class('log-msg is-open')
 s.evaluate("window.__emit('log',{task_id:1,manuscript_id:1})")
 s.wait_for_function("window.__calls.filter(c=>c.name==='listLogsPage').length>=2")
 expect(msg).to_have_class('log-msg is-open')
 print('PASS live logs retain expanded details',flush=True);s.close()
 s=page(r'''
 window.__newDrafts=[];functions.addManuscript=input=>{const id=100+window.__newDrafts.length;window.__newDrafts.push({...input,id});return id};
 functions.updateManuscript=(id,input)=>{const draft=window.__newDrafts.find(d=>d.id===id);Object.assign(draft,input)};
 functions.createTask=input=>{if(!window.__taskRetry)throw new Error('fixture create task failed');return {id:99,start_error:null}};
 ''')
 s.get_by_role('button',name='投稿计划',exact=True).click();s.get_by_role('button',name='新建计划',exact=True).click()
 s.get_by_label('作品名称',exact=True).fill('失败重试复现')
 s.locator('.plan-desk input[type=file]').set_input_files({'name':'稿件.txt','mimeType':'text/plain','buffer':'有效的文稿'.encode()})
 s.get_by_role('button',name='下一步：选择编辑').click()
 s.get_by_role('button',name='下一步：选择邮箱').click()
 s.get_by_role('button',name='开始发送',exact=True).click()
 expect(s.get_by_text('Error: fixture create task failed',exact=True)).to_be_visible()
 s.evaluate('window.__taskRetry=true')
 s.get_by_role('button',name='开始发送',exact=True).click()
 expect(s.locator('.plans-table')).to_be_visible()
 assert s.evaluate('window.__newDrafts.length')==1
 assert s.evaluate("window.__calls.filter(c=>c.name==='updateManuscript').length")==1
 print('PASS task creation retry reuses the persisted manuscript',flush=True);s.close()
 s=page(r'''
 accounts[0]={...accounts[0],smtp_host:'smtp.custom.example',smtp_port:2465,imap_host:'imap.custom.example',imap_port:2993,check_replies:true};
 functions.updateAccount=(id,input)=>{window.__savedAccount=input};
 ''')
 s.get_by_role('button',name='邮箱管理',exact=True).click()
 s.get_by_role('table').get_by_role('button',name='编辑',exact=True).click()
 d=s.get_by_role('dialog');expect(d.get_by_label('授权码',exact=True)).to_have_value('')
 d.get_by_label('笔名（可选）').fill('新笔名');d.get_by_role('button',name='保存配置').click()
 expect(d).to_have_count(0)
 saved=s.evaluate('window.__savedAccount')
 assert (saved['smtp_host'],saved['smtp_port'],saved['imap_host'],saved['imap_port'],saved['password'])==('smtp.custom.example',2465,'imap.custom.example',2993,'')
 print('PASS account name edits preserve custom server settings and leave the stored secret untouched',flush=True);s.close()
 s=page(r'''
 const many=Array.from({length:5001},(_,i)=>({id:i+1,email:`e${i+1}@example.com`,name:`编辑${i+1}`,platform:'平台',work_type:['短篇'],rejected_types:[],notes:'',enabled:true,favorited:false}));
 functions.listEditors=()=>many;functions.listEditorGroups=()=>[{id:1,name:'大分组',editor_ids:many.map(e=>e.id)}];
 ''')
 s.get_by_role('button',name='编辑组',exact=True).click()
 expect(s.locator('.editor-group-roster-row')).to_have_count(50)
 s.get_by_label('搜索组内成员').fill('e5001@')
 expect(s.locator('.editor-group-roster-row')).to_have_count(1)
 expect(s.locator('.editor-group-roster-row')).to_contain_text('编辑5001')
 print('PASS 5001-member group renders only 50 rows and searches all members',flush=True);s.close()
 s=page()
 before=s.evaluate("window.__calls.filter(c=>c.name==='getStats').length")
 loaded=s.evaluate("window.__calls.filter(c=>c.name==='dashboard').length")
 s.evaluate("window.__emit('log',{task_id:1})")
 s.wait_for_function("n=>window.__calls.filter(c=>c.name==='dashboard').length>n",arg=loaded)
 assert s.evaluate("window.__calls.filter(c=>c.name==='getStats').length")==before
 assert s.evaluate("window.__calls.filter(c=>c.name==='dashboard').every(c=>c.args[0]==='human')")
 print('PASS dashboard requests filtered replies and log refresh does not reload trends',flush=True);s.close()
 s=page(r'''
 const originalSettings=functions.getSettings;
 functions.getSettings=()=>{if(!window.__allowSettings)throw new Error('fixture settings unavailable');return originalSettings()};
 ''')
 s.get_by_role('button',name='设置',exact=True).click()
 expect(s.get_by_role('alert')).to_contain_text('fixture settings unavailable')
 s.get_by_role('button',name='发送',exact=True).click()
 expect(s.get_by_label('发送失败后重试几次')).to_be_disabled()
 expect(s.get_by_role('button',name='保存设置')).to_be_disabled()
 s.evaluate('window.__allowSettings=true')
 s.get_by_role('button',name='重新读取设置').click()
 expect(s.get_by_label('发送失败后重试几次')).to_be_enabled()
 expect(s.get_by_role('alert')).to_have_count(0)
 s.get_by_label('发送失败后重试几次').fill('7')
 s.get_by_role('button',name='保存设置').click()
 s.wait_for_function('window.__settings?.default_retry_max===7')
 print('PASS settings load failure is retryable and cannot overwrite settings with fallback defaults',flush=True);s.close()
 s=page(r'''
 accounts.push({...accounts[0],id:2,email:'second@example.com'});
 window.__finishTests={};functions.testAccount=id=>new Promise(resolve=>window.__finishTests[id]=()=>resolve('连接成功'));
 ''')
 s.get_by_role('button',name='邮箱管理',exact=True).click()
 rows=s.get_by_role('table').locator('tbody tr');expect(rows).to_have_count(2)
 first=rows.nth(0).get_by_role('button',name=re.compile('测试'))
 second=rows.nth(1).get_by_role('button',name=re.compile('测试'))
 first.click();second.click()
 expect(first).to_be_disabled();expect(second).to_be_disabled()
 s.evaluate('window.__finishTests[2]()')
 expect(second).to_be_enabled();expect(first).to_be_disabled()
 assert s.evaluate("window.__calls.filter(c=>c.name==='testAccount'&&c.args[0]===1).length")==1
 s.evaluate('window.__finishTests[1]()');expect(first).to_be_enabled()
 print('PASS concurrent account tests retain independent busy states until each completes',flush=True);s.close()
 s=page(r'''
 task.status='stopped';m.recipients=['a@example.com','manual@example.com'];
 functions.listEditorGroups=()=>[{id:1,name:'常投组',editor_ids:[1]}];
 functions.updateManuscript=(id,input)=>{window.__savedRecipients=input.recipients};
 ''')
 s.get_by_role('button',name='投稿计划',exact=True).click()
 s.get_by_role('button',name='编辑计划',exact=True).click()
 expect(s.locator('.plan-desk')).to_be_visible()
 s.get_by_role('button',name='保存草稿',exact=True).click()
 expect(s.locator('.plans-table')).to_be_visible()
 assert s.evaluate("window.__savedRecipients.includes('manual@example.com')")
 assert len(s.evaluate('window.__savedRecipients'))==2
 print('PASS existing plans retain out-of-library recipients even when known editors match a group',flush=True);s.close()
 s=page(r'''
 functions.cleanStorage=(scope,keep)=>{window.__cleaned={scope,keep};return scope==='mail_cache'?198:2};
 ''')
 s.get_by_role('button',name='设置',exact=True).click()
 s.get_by_role('button',name='备份与空间',exact=True).click()
 area=s.get_by_label('存储空间管理');expect(area).to_contain_text('700 封')
 s.get_by_role('button',name='清理邮件缓存',exact=True).click()
 dialog=s.get_by_role('alertdialog',name='清理邮件缓存？');expect(dialog).to_contain_text('服务器已删除的邮件可能无法恢复')
 dialog.get_by_role('button',name='取消',exact=True).click()
 assert s.evaluate('window.__cleaned') is None
 s.get_by_role('button',name='清理邮件缓存',exact=True).click()
 s.get_by_role('button',name='确认清理',exact=True).click()
 s.wait_for_function("window.__cleaned?.scope==='mail_cache'")
 assert s.evaluate('window.__cleaned.keep')==500
 s.get_by_role('button',name='清理旧备份',exact=True).click()
 s.get_by_role('button',name='确认清理',exact=True).click()
 s.wait_for_function("window.__cleaned?.scope==='backups'")
 assert s.evaluate('window.__cleaned.keep')==10
 print('PASS storage usage, separate cleanup scopes, explicit confirmation and selected retention counts',flush=True);s.close()
 b.close()

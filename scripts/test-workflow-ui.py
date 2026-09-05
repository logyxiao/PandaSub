"""Headless UI regression with a mocked Tauri API; never opens the user database or sends mail."""
import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

MOCK = r'''
const task = { id: 1, name: '回归测试计划', manuscript_ids: [1], account_ids: [1], status: 'running', schedule_type: 'immediate', scheduled_at: null, retry_max: 3, sent: 1, total: 3, created_at: '2026-09-06 10:00:00', started_at: '2026-09-06 10:00:00', finished_at: null };
const m = {id:1,title:'回归测试计划',body:'正文',content_type:'text/plain',recipients:['a@example.com','b@example.com','c@example.com'],sender_name:'作者',word_count:1000,category:'短篇',reader_emotion:'',style:'',genres:['短篇'],account_ids:[1],subject:'主题',file_name:'',created_at:'2026-09-06 10:00:00',updated_at:'2026-09-06 10:00:00'};
const accounts = [{id:1,email:'fixture@example.com',enabled:true,sender_name:'作者',provider:'qq',sent_today:1}];
const replies = Array.from({length:305},(_,i)=>({id:305-i,delivery_id:1,account_id:1,task_id:1,from_email:'a@example.com',subject:'回复'+(305-i),snippet:'摘录',body:i===304?'最早的历史回复':'回复内容'+(305-i),kind:'human',reason:'人工',accepted:false,message_id:'r'+i,in_reply_to:'d1',imap_uid:i,received_at:'2026-01-02 03:04:05',created_at:'2026-09-06 12:00:00',recipient:'a@example.com',task_name:'回归测试计划'}));
const deliveries = [{id:1,task_id:1,account_id:1,manuscript_id:1,recipient:'a@example.com',subject:'主题',message_id:'m1',sent_at:'2026-09-06 10:00:00'}];
const logs=Array.from({length:305},(_,i)=>({id:305-i,task_id:1,manuscript_id:1,account_id:1,level:i===304?'error':'success',category:'send',message:i===304?'最早的失败记录':'发送成功',recipient:i===304?'old_100%@example.com':'other@example.com',created_at:'2026-09-06 10:00:00'}));
window.__manuscript=m; window.__calls=[]; const events={task: new Set(), log:new Set(), reply:new Set()};
window.__emit=(name,payload)=>events[name].forEach(fn=>fn(payload)); window.__task=task;
function on(name,fn){events[name].add(fn);return Promise.resolve(()=>events[name].delete(fn))}
export const onTask=(fn)=>on('task',fn);export const onLog=(fn)=>on('log',fn);export const onReply=(fn)=>on('reply',fn);
const stats=Array.from({length:405},(_,i)=>({period:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),deliveries:1,human_replies:0,accepted:0,failures:0}));
window.__sentToday=1;
const functions={
 sendManualDelivery:()=>new Promise(resolve=>{window.__finishManual=resolve}),
 pauseTask:()=>{task.status='paused';window.__emit('task',{...task})},
 resumeTask:()=>{task.status='running';window.__emit('task',{...task})},
 getStats:(start,end,group)=>{
   if(start&&end&&start>end)return Promise.reject(new Error('统计开始日期应早于或等于结束日期'));
   const selected=stats.filter(r=>(!start||r.period>=start)&&(!end||r.period<=end));
   const map=new Map();
   for(const row of selected){const period=group==='month'?row.period.slice(0,7):row.period;const old=map.get(period);map.set(period,old?{...old,deliveries:old.deliveries+row.deliveries}:{...row,period})}
   return{groups:[...map.values()],totals:{period:'',deliveries:selected.length,human_replies:0,accepted:0,failures:0}};
 },
 runningTaskCount:()=>1,
 dashboard:()=>({account_count:1,manuscript_count:1,editor_count:1,sent_today:window.__sentToday,failed_today:0,running_tasks:1,human_replies:305,auto_replies:0,accepted_replies:0,tasks:[task],recent_replies:replies.slice(0,30)}),
 listManuscripts:()=>[m],listTasks:()=>[task],listAccounts:()=>accounts,
 listEditors:()=>[{id:1,email:'a@example.com',name:'编辑甲',platform:'平台',work_type:['短篇'],rejected_types:[],notes:'',enabled:true,favorited:false}],
 listEditorGroups:()=>[],getDefaultMailTemplates:()=>[{id:'t1',name:'模板',subject:'投稿+{{字数}}+{{类型}}',body:'编辑您好'}],saveDefaultMailTemplates:()=>null,
 getSettings:()=>({default_retry_max:3,anti_spam_mutation:false,reply_poll_minutes:2}),
 listDeliveries:()=>{throw new Error('Full delivery history must not be fetched')},
 deliverySummaryPage:(id,emails,matching,filter,limit,offset)=>{
   if(id!==1)throw new Error('Unscoped detail');
   if(window.__failDetail)return Promise.reject(new Error('记录加载失败 fixture'));
   const all=emails.map((email,row_index)=>{const sent=deliveries.filter(d=>d.manuscript_id===id&&d.recipient.toLowerCase()===email.toLowerCase());const latest=sent.at(-1);return{row_index,sent_count:sent.length,latest_id:latest?.id??null,last_sent_at:latest?.sent_at??null}});
   const rows=all.filter(r=>matching.includes(r.row_index)&&(filter==='all'||(filter==='sent'?r.sent_count>0:r.sent_count===0)));
   const result={items:rows.slice(offset,offset+limit),total:rows.length,sent_total:all.filter(r=>r.sent_count>0).length};
   if(window.__deferDetail){window.__deferDetail=false;return new Promise(resolve=>{window.__finishDetail=()=>resolve(result)})}
   return result;
 },
 listPendingSends:()=>window.__pending??[],
 resolvePendingSend:(id,sent)=>{if(sent)deliveries.push({id:2,task_id:1,account_id:1,manuscript_id:1,recipient:'b@example.com',subject:'主题',message_id:'pending',sent_at:'2026-09-06 10:00:00'});window.__pending=[]},
 listLogsPage:(taskId,level,q,limit,offset)=>{q=q.trim().toLowerCase();const rows=logs.filter(l=>(!taskId||l.task_id===taskId)&&(!level||l.level===level)&&(!q||l.recipient.toLowerCase().includes(q)||accounts[0].email.includes(q)));return{total:rows.length,items:rows.slice(offset,offset+limit)}},
 exportLogs:(path)=>path,
 listRepliesPage:(kind,taskId,q,limit,offset)=>{let rows=replies.filter(r=>(!kind||r.kind===kind)&&(!taskId||r.task_id===taskId)&&(!q||r.body.includes(q)));return{total:rows.length,items:rows.slice(offset,offset+limit)}},
};
export const api=new Proxy({}, {get:(_,name)=>(...args)=>{window.__calls.push({name,args});if(!(name in functions))return Promise.reject(new Error('Unexpected API: '+name));return Promise.resolve(functions[name](...args))}});
'''
UPDATE = '''export const RELEASES_URL='';export const currentVersion=async()=> '0.2.3';export const availableUpdate=async()=>null;export const installUpdate=async()=>{};export const restartApp=async()=>{};'''
artifacts = Path(tempfile.mkdtemp(prefix='novelsub-ui-'))
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={"width":1440,"height":1000})
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.route('**/src/api.ts*',lambda route:route.fulfill(status=200,content_type='application/javascript',body=MOCK))
    page.route('**/*plugin-dialog*',lambda route:route.fulfill(status=200,content_type='application/javascript',body="export const save=async()=>'/tmp/novelsub-log-export-fixture.xlsx';"))
    page.route('**/src/update.ts*',lambda route:route.fulfill(status=200,content_type='application/javascript',body=UPDATE))
    page.clock.install()
    page.goto(os.environ.get('NOVELSUB_TEST_URL', 'http://127.0.0.1:5179'))
    page.wait_for_load_state('networkidle')
    success=page.locator('.stat').filter(has=page.get_by_text('今日成功',exact=True)).locator('.stat-value')
    expect(success).to_have_text('1封')
    before=page.evaluate("window.__calls.filter(c=>c.name==='dashboard').length")
    page.evaluate("for(let i=0;i<10;i++){window.__emit('log',{id:1,level:'success',category:'send'});window.__emit('reply',{id:305,kind:'human',accepted:false})}")
    page.wait_for_function("n=>window.__calls.filter(c=>c.name==='dashboard').length>n",arg=before)
    expect(success).to_have_text('1封')
    expect(page.locator('.stat').filter(has=page.get_by_text('人工回复',exact=True)).locator('.stat-value')).to_have_text('305封')
    page.evaluate('window.__sentToday=0')
    page.clock.fast_forward(61_000)
    page.clock.fast_forward(250)
    expect(success).to_have_text('0封')
    page.get_by_role('button',name='投稿计划',exact=True).click()
    expect(page.locator('tbody')).to_contain_text('回归测试计划')
    expect(page.locator('.rt-meta')).to_have_text('1 / 3')
    expect(page.locator('tbody').get_by_role('button',name='编辑',exact=True)).to_be_disabled()
    expect(page.get_by_title('配置投稿邮箱')).to_be_disabled()
    assert not page.evaluate("window.__calls.filter(c=>c.name==='listDeliveries')")
    page.locator('tbody').get_by_role('button',name='暂停',exact=True).click()
    expect(page.locator('tbody').get_by_role('button',name='继续',exact=True)).to_be_visible()
    expect(page.locator('tbody').get_by_role('button',name='编辑',exact=True)).to_be_disabled()
    page.locator('tbody').get_by_role('button',name='继续',exact=True).click()
    expect(page.locator('tbody').get_by_role('button',name='暂停',exact=True)).to_be_visible()
    dashboard_calls=page.evaluate("window.__calls.filter(c=>c.name==='dashboard').length")
    engine_calls=page.evaluate("window.__calls.filter(c=>c.name==='runningTaskCount').length")
    page.evaluate("window.__emit('task',{...window.__task,sent:2})")
    page.clock.fast_forward(250)
    page.wait_for_function("n=>window.__calls.filter(c=>c.name==='runningTaskCount').length>n",arg=engine_calls)
    assert page.evaluate("window.__calls.filter(c=>c.name==='dashboard').length")==dashboard_calls
    expect(page.locator('.rt-meta')).to_have_text('2 / 3')
    assert not page.evaluate("window.__calls.filter(c=>c.name==='listDeliveries')")
    page.locator('tbody').get_by_role('button',name='记录',exact=True).click()
    expect(page.get_by_role('dialog')).to_be_visible()
    expect(page.get_by_role('dialog')).to_contain_text('a@example.com')
    expect(page.get_by_role('dialog').get_by_title('重新发送该编辑')).to_be_disabled()
    page.evaluate("window.__task.status='stopped';window.__emit('task',{...window.__task})")
    expect(page.get_by_role('dialog').get_by_title('重新发送该编辑')).to_be_enabled()
    page.get_by_role('dialog').locator('tbody tr').filter(has_text='b@example.com').get_by_role('button',name='手动发送',exact=True).click()
    expect(page.get_by_role('alertdialog')).to_be_visible()
    page.get_by_role('alertdialog').get_by_role('button',name='手动发送',exact=True).click()
    page.wait_for_function("typeof window.__finishManual==='function'")
    expect(page.get_by_role('dialog').get_by_title('重新发送该编辑')).to_be_disabled()
    expect(page.get_by_role('dialog').get_by_role('button',name='添加编辑',exact=True)).to_be_disabled()
    for button in page.get_by_role('dialog').get_by_title('移除该编辑',exact=True).all():
        expect(button).to_be_disabled()
    page.evaluate('window.__finishManual()')
    expect(page.get_by_role('dialog').get_by_role('button',name='添加编辑',exact=True)).to_be_enabled()
    page.wait_for_function("window.__calls.some(c=>c.name==='deliverySummaryPage'&&c.args[0]===1)")
    assert not page.evaluate("window.__calls.some(c=>c.name==='listDeliveries')")
    # Pending network results are visible and block another send until explicit reconciliation.
    page.evaluate("window.__pending=[{id:1,account_id:1,manuscript_id:1,task_id:1,recipient:'b@example.com',subject:'主题',message_id:'<pending>',created_at:'2026-09-06 10:00:00'}];window.__emit('log',{manuscript_id:1})")
    page.clock.fast_forward(250)
    expect(page.get_by_role('dialog')).to_contain_text('发送结果待确认')
    expect(page.get_by_role('dialog').get_by_role('button',name='添加编辑',exact=True)).to_be_disabled()
    page.screenshot(path=str(artifacts / 'pending-confirmation.png'),full_page=True)
    page.get_by_role('dialog').get_by_role('button',name='已发出，补记成功',exact=True).click()
    expect(page.get_by_role('alertdialog')).to_contain_text('不再发送邮件')
    page.get_by_role('alertdialog').get_by_role('button',name='已核对，补记成功',exact=True).click()
    expect(page.get_by_role('dialog').locator('[role="status"]')).to_have_count(0)
    expect(page.get_by_role('dialog').locator('tbody tr').filter(has_text='b@example.com')).to_contain_text('已发送')
    assert page.evaluate("window.__calls.filter(c=>c.name==='sendManualDelivery').length")==1
    # Late responses from an older filter never replace the current rows.
    page.evaluate('window.__deferDetail=true')
    page.get_by_role('dialog').get_by_placeholder('搜索姓名、平台、邮箱或备注').fill('a@example.com')
    page.wait_for_function("typeof window.__finishDetail==='function'")
    page.get_by_role('dialog').get_by_placeholder('搜索姓名、平台、邮箱或备注').fill('c@example.com')
    expect(page.get_by_role('dialog').locator('tbody')).to_contain_text('c@example.com')
    page.evaluate('window.__finishDetail()')
    expect(page.get_by_role('dialog').locator('tbody')).not_to_contain_text('a@example.com')
    page.evaluate('window.__failDetail=true')
    page.get_by_role('dialog').get_by_placeholder('搜索姓名、平台、邮箱或备注').fill('b@example.com')
    expect(page.get_by_role('dialog').get_by_role('alert')).to_contain_text('记录加载失败 fixture')
    expect(page.get_by_role('dialog').get_by_role('button',name='添加编辑',exact=True)).to_be_disabled()
    page.evaluate('window.__failDetail=false')
    page.get_by_role('dialog').get_by_role('button',name='重试加载',exact=True).click()
    expect(page.get_by_role('dialog').locator('tbody')).to_contain_text('b@example.com')
    page.get_by_role('dialog').get_by_placeholder('搜索姓名、平台、邮箱或备注').fill('')
    page.screenshot(path=str(artifacts / 'plan-detail.png'),full_page=True)
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    page.evaluate("window.__manuscript.recipients=[...window.__manuscript.recipients,...Array.from({length:20},(_,i)=>'extra'+i+'@example.com')]")
    page.locator('tbody').get_by_role('button',name='记录',exact=True).click()
    expect(page.get_by_role('dialog').locator('tbody tr')).to_have_count(10)
    expect(page.get_by_role('dialog').locator('.pager-meta')).to_contain_text('共 23 条')
    page.get_by_role('dialog').get_by_role('button',name='下一页',exact=True).click()
    expect(page.get_by_role('dialog').locator('.pager-meta')).to_contain_text('第 11–20 条')
    assert page.evaluate("window.__calls.filter(c=>c.name==='deliverySummaryPage').at(-1).args[5]")==10
    page.get_by_role('dialog').get_by_placeholder('搜索姓名、平台、邮箱或备注').fill('extra19@example.com')
    expect(page.get_by_role('dialog').locator('.pager-meta')).to_contain_text('第 1–1 条，共 1 条')
    expect(page.get_by_role('dialog').locator('tbody')).to_contain_text('extra19@example.com')
    page.get_by_role('dialog').get_by_placeholder('搜索姓名、平台、邮箱或备注').fill('')
    page.get_by_role('dialog').get_by_role('group',name='发送状态筛选').get_by_role('button',name='已发送',exact=True).click()
    expect(page.get_by_role('dialog').locator('.pager-meta')).to_contain_text('共 2 条')
    page.evaluate("window.__pending=[{id:2,account_id:1,manuscript_id:1,task_id:1,recipient:'c@example.com',subject:'主题',message_id:'<pending2>',created_at:'2026-09-06 10:00:00'}];window.__emit('log',{manuscript_id:1})")
    page.clock.fast_forward(250)
    expect(page.get_by_role('dialog')).to_contain_text('发送结果待确认')
    page.get_by_role('dialog').get_by_role('button',name='未发出，解除待确认',exact=True).click()
    expect(page.get_by_role('alertdialog')).to_contain_text('仅凭发件箱没有记录不足以确认')
    page.get_by_role('alertdialog').get_by_role('button',name='已核对，解除待确认',exact=True).click()
    expect(page.get_by_role('dialog').locator('[role="status"]')).to_have_count(0)
    assert page.evaluate("window.__calls.filter(c=>c.name==='sendManualDelivery').length")==1
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    page.get_by_role('button',name='回复',exact=True).click()
    expect(page.locator('.pager-meta')).to_contain_text('共 305 条')
    expect(page.locator('tbody tr')).to_have_count(20)
    page.get_by_role('button',name='16',exact=True).click()
    expect(page.locator('tbody tr')).to_have_count(5)
    expect(page.locator('tbody')).to_contain_text('最早的历史回复')
    page.get_by_placeholder('搜索回复、编辑或邮箱').fill('最早')
    expect(page.locator('.pager-meta')).to_contain_text('共 1 条')
    expect(page.locator('tbody tr')).to_have_count(1)
    expect(page.locator('.pager-meta')).to_contain_text('第 1–1 条')
    page.screenshot(path=str(artifacts / 'replies.png'),full_page=True)
    page.get_by_role('button',name='记录',exact=True).click()
    expect(page.locator('.pager-meta')).to_contain_text('共 305 条')
    expect(page.locator('tbody tr')).to_have_count(20)
    page.get_by_role('button',name='16',exact=True).click()
    expect(page.locator('tbody tr')).to_have_count(5)
    expect(page.locator('tbody')).to_contain_text('最早的失败记录')
    page.get_by_placeholder('搜索发件 / 编辑邮箱').fill('old_100%')
    expect(page.locator('.pager-meta')).to_contain_text('共 1 条')
    expect(page.locator('.pager-meta')).to_contain_text('第 1–1 条')
    page.get_by_role('button',name='按结果筛选').click()
    page.get_by_role('option',name='失败',exact=True).click()
    expect(page.locator('tbody tr')).to_have_count(1)
    page.get_by_role('button',name='导出 Excel',exact=True).click()
    page.wait_for_function("window.__calls.some(c=>c.name==='exportLogs')")
    assert page.evaluate("window.__calls.find(c=>c.name==='exportLogs').args")==['/tmp/novelsub-log-export-fixture.xlsx',None,'error','old_100%']
    page.evaluate("window.__emit('log',{id:999,task_id:1,level:'success',recipient:'other@example.com'})")
    page.clock.fast_forward(250)
    expect(page.locator('tbody tr')).to_have_count(1)
    expect(page.locator('tbody')).to_contain_text('最早的失败记录')
    page.screenshot(path=str(artifacts / 'logs.png'),full_page=True)
    page.get_by_role('button',name='统计',exact=True).click()
    expect(page.locator('.pager-meta')).to_contain_text('共 405 条')
    expect(page.locator('tbody tr')).to_have_count(50)
    page.get_by_role('button',name='9',exact=True).click()
    expect(page.locator('tbody tr')).to_have_count(5)
    page.locator('input[type=date]').nth(0).fill('2025-01-01')
    page.locator('input[type=date]').nth(1).fill('2025-01-03')
    expect(page.locator('.pager-meta')).to_contain_text('共 3 条')
    expect(page.locator('.pager-meta')).to_contain_text('第 1–3 条')
    expect(page.locator('.stats-card-value').first).to_have_text('3')
    page.locator('input[type=date]').nth(0).fill('2025-02-01')
    expect(page.locator('.notice-error')).to_contain_text('开始日期')
    expect(page.locator('.stats-cards')).to_have_count(0)
    page.get_by_role('button',name='全部',exact=True).click()
    expect(page.locator('input[type=date]').nth(0)).to_have_value('')
    expect(page.locator('input[type=date]').nth(1)).to_have_value('')
    expect(page.locator('.pager-meta')).to_contain_text('共 405 条')
    page.get_by_role('button',name='统计粒度',exact=True).click()
    page.get_by_role('option',name='按月统计',exact=True).click()
    expect(page.locator('.pager-meta')).to_contain_text('共 14 条')
    expect(page.locator('tbody tr')).to_have_count(14)
    page.screenshot(path=str(artifacts / 'stats.png'),full_page=True)
    assert not errors, errors
    print('PASS: 23 recipient detail backend pagination/search/status filter, stale-response suppression, load failure retry, both pending-result confirmations without SMTP; active task blocks historical resend; pending manual send locks mutations; 405 stats periods bounded to 50 rows, filter/page reset and errors cleared, pause/resume controls; dashboard persisted counters do not double-count, minute refresh and lightweight engine query; 305 logs with server filters and matching export;  active config locked; task events update current-round progress without delivery refetch; scoped detail history; 305 replies paginated and oldest reply searchable; no browser exceptions')
    print(f"Screenshots: {artifacts}")
    browser.close()

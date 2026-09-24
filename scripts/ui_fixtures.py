"""Shared isolated browser fixtures. No Tauri backend or user data is accessed."""
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

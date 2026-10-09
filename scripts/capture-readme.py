"""Capture current React views with fictional data; never starts Tauri or reads user data.

Run against a frontend-only Vite server:
  NOVELSUB_TEST_URL=http://127.0.0.1:5179 python3 scripts/capture-readme.py
"""
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from ui_fixtures import MOCK, UPDATE

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get('NOVELSUB_TEST_URL', 'http://127.0.0.1:5179')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local frontend-only server'

# All visible records below are invented for documentation. No database access.
SHOWCASE = r'''
Object.assign(accounts[0], {email:'author@example.com',sender_name:'林间',provider:'other',sent_today:8});
Object.assign(m, {title:'山海来信',body:'编辑您好，随信附上短篇《山海来信》，感谢审阅。',subject:'短篇投稿｜山海来信｜12000字',word_count:12000,file_name:'山海来信.docx',has_file:true,send_interval_min:100,send_interval_max:240,created_at:'2026-10-09 09:00:00',updated_at:'2026-10-09 09:00:00'});
Object.assign(task, {name:m.title,sent:2,total:3,created_at:'2026-10-09 09:00:00',started_at:'2026-10-09 09:00:00'});
const manuscripts=[m,{...m,id:2,title:'长街听雨',file_name:'长街听雨.docx',category:'现言'}, {...m,id:3,title:'星河慢递',file_name:'星河慢递.docx',category:'幻想'}];
const tasks=[task,{...task,id:2,name:'长街听雨',manuscript_ids:[2],status:'scheduled',schedule_type:'scheduled',scheduled_at:'2026-10-10 10:00:00',sent:0,started_at:null},{...task,id:3,name:'星河慢递',manuscript_ids:[3],status:'completed',sent:3,finished_at:'2026-10-08 15:00:00'}];
const editors=[
 {id:1,name:'青竹',platform:'星河故事',email:'a@example.com',work_type:['短篇','古言'],rejected_types:['校园'],notes:'收完整短篇，请附字数和故事梗概。',average_reply_seconds:172800,reply_sample_count:3,favorited:true},
 {id:2,name:'南山',platform:'青禾文学',email:'b@example.com',work_type:['短篇','现言'],rejected_types:[],notes:'都市情感、现实题材，正文请勿附网盘链接。',average_reply_seconds:345600,reply_sample_count:2,favorited:false},
 {id:3,name:'清和',platform:'拾光阅读',email:'c@example.com',work_type:['短篇','幻想'],rejected_types:[],notes:'完整故事优先，欢迎新作者来稿。',average_reply_seconds:259200,reply_sample_count:4,favorited:true},
].map(e=>({...e,enabled:true,source:'手动数据',created_at:'2026-10-01',updated_at:'2026-10-09'}));
replies.splice(0,replies.length,...[
 {subject:'Re: 短篇投稿｜山海来信',body:'林间，你好：\n\n已收到《山海来信》。故事设定很有趣，请补充一份简短的人物介绍，方便继续审阅。\n\n谢谢来稿，期待你的回复。\n青竹',kind:'human',from_email:'a@example.com',task_name:'山海来信'},
 {subject:'Re: 短篇投稿｜星河慢递',body:'你好，稿件已通过初审，将进入下一轮审核。最终结果会另行邮件通知。',kind:'human',from_email:'c@example.com',task_name:'星河慢递'},
 {subject:'自动回复：来稿已收到',body:'来稿已收到，审稿期间请耐心等待。',kind:'auto',from_email:'b@example.com',task_name:'长街听雨'},
].map((r,i)=>({...r,id:i+1,delivery_id:i+1,account_id:1,task_id:i+1,snippet:r.body,reason:r.kind==='auto'?'自动回复':'人工回复',accepted:false,is_read:i===2,read_synced:true,message_id:'showcase-'+i,in_reply_to:'showcase-delivery-'+i,imap_uid:i+1,received_at:`2026-10-09 ${String(11-i).padStart(2,'0')}:00:00`,created_at:'2026-10-09 11:00:00',recipient:r.from_email})));
serverSeen.clear();replies.forEach(r=>serverSeen.set(r.id,r.is_read));
const works=[
 {id:1,title:'月光小站',deal_mode:'buyout',price_cents:180000,sale_platform:'星河故事',buyer_editor:'青竹'},
 {id:2,title:'春日回声',deal_mode:'guarantee_share',per_thousand_cents:3000,word_count:12000,realized_share_cents:12000,sale_platform:'青禾文学',buyer_editor:'南山'},
].map(w=>({manuscript_id:null,source:'external',review_status:'accepted',body:'虚构展示文稿',file_name:'',has_file:false,accepted_at:'2026-10-08',sold_at:'2026-10-08',guarantee_cents:0,per_thousand_cents:0,price_cents:0,realized_share_cents:0,word_count:12000,monthly_settlements:[],share_percent:50,listing_platform:'',article_url:'',notes:'',record_origin:'manual',created_at:'2026-10-08',updated_at:'2026-10-08',...w}));
Object.assign(functions,{
 listManuscripts:()=>manuscripts,getManuscript:id=>manuscripts.find(m=>m.id===id),listTasks:()=>tasks,listEditors:()=>editors,
 listEditorGroups:()=>[{id:1,name:'短篇常投',editor_ids:[1,2,3],created_at:'2026-10-01',updated_at:'2026-10-09'}],
 listAcceptedWorks:()=>works,
 listAcceptedCandidates:()=>[{manuscript_id:3,title:'星河慢递',reply_id:2,received_at:'2026-10-09 10:00:00',sale_platform:'拾光阅读',buyer_editor:'清和',account_email:'author@example.com'}],
 dashboard:kind=>({account_count:1,manuscript_count:3,editor_count:3,sent_today:8,failed_today:0,running_tasks:1,human_replies:2,auto_replies:1,accepted_replies:0,tasks,recent_replies:replies.filter(r=>!kind||r.kind===kind)}),
 getStats:(start,end)=>{const rows=Array.from({length:7},(_,i)=>({period:`2026-10-${String(i+3).padStart(2,'0')}`,deliveries:[3,5,2,6,4,7,8][i],human_replies:[0,1,0,2,1,1,2][i],accepted:0,failures:0}));return {groups:rows,totals:{deliveries:35,human_replies:7,accepted:0,failures:0}};},
});
'''


def main():
    destination = ROOT / 'docs/screenshots'
    destination.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1, reduced_motion='reduce', timezone_id='Asia/Shanghai')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        # Block external requests; only local UI assets and in-memory APIs are allowed.
        context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).netloc == urlparse(URL).netloc else route.abort())
        page.route('**/src/api.ts*', lambda route: route.fulfill(content_type='application/javascript', body=MOCK.replace('fixture@example.com', 'author@example.com') + SHOWCASE))
        page.route('**/src/update.ts*', lambda route: route.fulfill(content_type='application/javascript', body=UPDATE.replace('0.2.3', '0.2.12')))
        page.route('**/*plugin-dialog*', lambda route: route.fulfill(content_type='application/javascript', body='export const save=async()=>null;export const open=async()=>null;'))
        page.clock.set_fixed_time('2026-10-09T12:00:00+08:00')
        page.goto(URL)
        page.wait_for_load_state('networkidle')
        nav = page.get_by_role('navigation', name='主导航')

        def capture(filename):
            page.wait_for_load_state('networkidle')
            page.evaluate('document.fonts.ready')
            expect(page.locator('.notice-error')).to_have_count(0)
            assert not errors, errors
            assert 'Invalid Date' not in page.locator('body').inner_text()
            # All email addresses on screen must use the reserved example.com domain.
            import re
            addresses = re.findall(r'[\w.+-]+@[\w.-]+', page.locator('body').inner_text())
            assert all(address.endswith('@example.com') for address in addresses), addresses
            page.screenshot(path=str(filename), animations='disabled')
            print(filename.relative_to(ROOT))

        expect(page.locator('.stat')).to_have_count(4)
        expect(page.locator('.dashboard-live')).to_be_visible()
        capture(ROOT / 'docs/preview.png')
        for title, filename, selector in [
            ('投稿计划', 'plans.png', '.plans-table tbody tr'),
            ('编辑库', 'editors.png', '.library-table tbody tr'),
            ('收件箱', 'inbox.png', '.reply-list-subject'),
            ('过稿统计', 'accepted.png', '.accepted-table tbody tr'),
        ]:
            if title == '过稿统计':
                page.set_viewport_size({'width': 1440, 'height': 1120})
            nav.get_by_role('button', name=title, exact=True).click()
            expect(page.locator(selector).first).to_be_visible()
            if title == '收件箱':
                page.locator('.reply-list-subject').filter(has_text='Re: 短篇投稿｜山海来信').click()
                expect(page.get_by_role('complementary', name='邮件阅读')).to_be_visible()
                expect(page.get_by_role('complementary', name='邮件阅读')).to_contain_text('已收到《山海来信》')
            capture(destination / filename)
        browser.close()


if __name__ == '__main__':
    main()

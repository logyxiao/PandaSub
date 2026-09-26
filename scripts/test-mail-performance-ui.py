"""A viewport-height email must settle instead of recursively growing its iframe."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
replies.splice(1);replies[0].read_synced=true;replies[0].is_read=true;serverSeen.set(replies[0].id,true);
functions.getReplyContent=()=>({from:[],to:[],cc:[],bcc:[],reply_to:[],sent_at:'',text:'测试正文',html:'<div style="min-height:100vh"><p>高度回归正文</p></div>',inline_images:{},attachments:[],complete:true});
window.__mailIdentity=replies[0];
window.__heights=[];window.addEventListener('message',e=>{if(e.data?.channel==='mail-body'&&e.data?.type==='height')window.__heights.push(e.data.value)});
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900})
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='收件箱',exact=True).click()
        page.locator('.reply-list-item').click()
        expect(page.frame_locator('iframe').get_by_text('高度回归正文')).to_be_visible()
        # Observe idle layout over a fixed window, not as a readiness wait.
        page.wait_for_timeout(1000)
        heights=page.evaluate('window.__heights')
        print(engine,'height messages:',len(heights),'last height:',heights[-1] if heights else None,flush=True)
        assert 0<len(heights)<=8,heights
        assert heights[-1]<1000,heights
        expect(page.get_by_role('button',name='加载外部图片',exact=True)).to_have_count(0)
        calls=page.evaluate("window.__calls.filter(c=>c.name==='getReplyContent').length")
        assert calls==1,calls
        frame_source=page.locator('iframe').get_attribute('srcdoc')
        page.get_by_role('dialog').get_by_role('button',name='完成',exact=True).click()
        page.locator('.reply-list-item').click()
        expect(page.frame_locator('iframe').get_by_text('高度回归正文')).to_be_visible()
        assert page.evaluate("window.__calls.filter(c=>c.name==='getReplyContent').length")==1
        assert page.locator('iframe').get_attribute('srcdoc')==frame_source, 'HTML was processed again'
        assert not page.evaluate("window.__calls.some(c=>c.name==='setReplyRead')"), 'Read mail must not create another IMAP write'
        print('PASS',engine,'stable height, one detail request, cached HTML reuse, no redundant seen write',flush=True)
        page.get_by_role('dialog').get_by_role('button',name='完成',exact=True).click()
        cache_checks=page.evaluate("""async()=>{
          const cache=await import('/src/lib/mailContentCache.ts');cache.clearMailContentCache();
          const row=window.__mailIdentity;
          const before=window.__calls.filter(c=>c.name==='getReplyContent').length;
          await Promise.all([cache.loadMailContent(row),cache.loadMailContent(row)]);
          const coalesced=window.__calls.filter(c=>c.name==='getReplyContent').length-before;
          await cache.loadMailContent({...row,imap_generation:99});
          const reset=window.__calls.filter(c=>c.name==='getReplyContent').length-before;
          cache.clearMailContentCache();
          for(let i=1;i<=13;i++)await cache.loadMailContent({...row,id:1000+i});
          return{coalesced,reset,evicted:cache.cachedMailContent({...row,id:1001})===null,retained:cache.cachedMailContent({...row,id:1013})!==null};
        }""")
        assert cache_checks=={'coalesced':1,'reset':2,'evicted':True,'retained':True},cache_checks
        print('PASS',engine,'concurrent request coalescing, mailbox identity isolation and bounded cache eviction',flush=True)
        browser.close()

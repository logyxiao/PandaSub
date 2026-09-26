"""MIME detail UI: HTML fidelity, isolated rendering, attachments and stale/error recovery."""
import os
import re
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const base={...replies[0],is_read:false,read_synced:true};
replies.splice(0,replies.length,{...base,id:1,subject:'稿件反馈与修改意见',body:'旧版保存的纯文本'}, {...base,id:2,subject:'另一封邮件',body:'另一封正文'});
replies.forEach(r=>serverSeen.set(r.id,r.is_read));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=';
const detail={from:[{name:'张编辑',email:'editor@example.com'}],to:[{name:'作者',email:'author@example.com'},{name:'读者',email:'reader@example.com'}],cc:[{name:'复审编辑',email:'review@example.com'}],bcc:[],reply_to:[{name:'编辑部',email:'desk@example.com'}],sent_at:'2026-09-26T12:30:00+08:00',text:'编辑您好：\n完整纯文本 & 段落。\n\nOn Friday someone wrote:\n> 引用内容',html:`<html><head><style>td{padding:12px;background:#f4f7f5}h2{color:#245c45}</style></head><body><h2>编辑您好：</h2><p>保留段落、<b>加粗</b>与 &amp; 符号。</p><table><tr><td>修改项</td><td>补充人物关系</td></tr></table><p><a href="https://example.invalid/review">查看完整意见</a></p><img alt="内嵌签名" src="cid:signature"><img alt="远程插图" src="https://example.invalid/tracker.png"><blockquote>完整引用的原邮件</blockquote><script>window.top.__mailXss=1</script><img src="x" onerror="window.top.__mailXss=2"><a href="javascript:window.top.__mailXss=3">恶意链接</a><iframe src="https://example.invalid/frame"></iframe><form action="https://example.invalid/post"><input autofocus></form><svg onload="window.top.__mailXss=4"></svg></body></html>`,inline_images:{signature:png},attachments:[{index:0,name:'修改意见.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:4096,content_id:''},{index:1,name:'signature.png',mime:'image/png',size:68,content_id:'signature'}],complete:true};
window.__detail=detail;
functions.getReplyContent=id=>{
 if(window.__failDetail)throw new Error('邮箱暂时离线');
 if(window.__slowDetail){window.__slowDetail=false;return new Promise(resolve=>window.__finishMailDetail=()=>resolve(detail))}
 return id===1?detail:{...detail,html:'',text:'另一封完整正文',attachments:[]};
};
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[]; remote=[]
        page.on('pageerror',lambda e:(errors.append(str(e)),print(engine,'PAGE ERROR:',e.stack,flush=True)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.route('**/*plugin-dialog*',lambda r:r.fulfill(content_type='application/javascript',body="export const save=async()=>'/tmp/mail-detail-fixture.docx';export const open=async()=>null;"))
        def remote_request(route):
            remote.append(route.request.url)
            route.fulfill(status=200,content_type='image/png',body=b'')
        page.route('https://example.invalid/**',remote_request)
        page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='收件箱',exact=True).click()
        rows=page.locator('.reply-list-item');rows.filter(has_text='稿件反馈与修改意见').click()
        dialog=page.get_by_role('dialog',name='邮件阅读')
        body=page.frame_locator('iframe[title="邮件 HTML 正文"]')
        expect(body.get_by_text('补充人物关系')).to_be_visible()
        expect(body.locator('td').first).to_have_css('padding-top','12px')
        expect(body.locator('b')).to_have_text('加粗')
        expect(body.locator('blockquote')).to_have_text('完整引用的原邮件')
        expect(body.get_by_alt_text('内嵌签名')).to_have_attribute('src',re.compile('^data:image/png;base64,'))
        expect(body.get_by_alt_text('远程插图')).to_have_attribute('src','https://example.invalid/tracker.png')
        expect(dialog.get_by_role('button',name='加载外部图片',exact=True)).to_have_count(0)
        assert page.evaluate('window.__mailXss') is None
        expect(page.locator('iframe')).to_have_attribute('sandbox','allow-scripts')
        page.evaluate("window.postMessage({channel:'mail-body',token:'forged',type:'link',value:'https://example.invalid/forged'},'*')")
        expect(body.locator('script:not([nonce]),iframe,form,input,svg')).to_have_count(0)
        expect(body.get_by_text('恶意链接')).not_to_have_attribute('href',re.compile('.+'))
        dialog.get_by_text('查看邮件详情',exact=True).click()
        envelope=dialog.locator('.mail-envelope')
        for text in ['张编辑 <editor@example.com>','author@example.com','reader@example.com','review@example.com','desk@example.com']:
            expect(envelope).to_contain_text(text)
        expect(body.get_by_alt_text('远程插图')).to_have_attribute('src','https://example.invalid/tracker.png')
        expect(body.get_by_alt_text('远程插图')).to_be_visible()
        assert remote==['https://example.invalid/tracker.png'],remote
        body.get_by_role('link',name='查看完整意见').click()
        page.wait_for_function("window.__calls.some(c=>c.name==='openMailLink'&&c.args[0]==='https://example.invalid/review')")
        dialog.get_by_role('button',name='查看纯文本',exact=True).click()
        expect(dialog).to_contain_text('完整纯文本 & 段落。')
        expect(dialog.get_by_text('展开引用的原邮件')).to_be_visible()
        dialog.get_by_text('展开引用的原邮件').click()
        expect(dialog).to_contain_text('> 引用内容')
        attachment=dialog.locator('.mail-attachment').filter(has_text='修改意见.docx')
        expect(attachment).to_contain_text('4.0 KB')
        attachment.get_by_role('button',name='保存',exact=True).click()
        page.wait_for_function("window.__calls.some(c=>c.name==='saveReplyAttachment'&&c.args[0]===1&&c.args[1]===0)")
        dialog.get_by_role('button',name='查看原始排版',exact=True).click()
        expected_height=body.locator('body > div').first.evaluate('root=>Math.max(120,Math.min(20000,Math.ceil(Math.max(root.scrollHeight+root.offsetTop,root.getBoundingClientRect().bottom+window.scrollY))+12))')
        expect(page.locator('iframe')).to_have_css('height',f'{expected_height}px')
        page.screenshot(path=f'/tmp/novelsub-mail-detail-{engine}.png')
        page.set_viewport_size({'width':720,'height':560})
        expect(dialog.get_by_role('button',name='完成',exact=True)).to_be_visible()
        box=dialog.bounding_box();assert box['y']>=0 and box['y']+box['height']<=560
        assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth'), 'Horizontal modal overflow'
        dialog.get_by_role('button',name='完成',exact=True).click()
        page.evaluate("async()=>{(await import('/src/lib/mailContentCache.ts')).clearMailContentCache();window.__failDetail=true}")
        rows.filter(has_text='稿件反馈与修改意见').click()
        expect(dialog).to_contain_text('邮箱暂时离线')
        expect(dialog).to_contain_text('旧版保存的纯文本')
        page.evaluate('window.__failDetail=false')
        dialog.get_by_role('button',name='重试加载',exact=True).click()
        expect(body.get_by_text('补充人物关系')).to_be_visible()
        dialog.get_by_role('button',name='完成',exact=True).click()
        page.evaluate("async()=>{(await import('/src/lib/mailContentCache.ts')).clearMailContentCache();window.__slowDetail=true}")
        rows.filter(has_text='稿件反馈与修改意见').click()
        page.wait_for_function("typeof window.__finishMailDetail==='function'")
        dialog.get_by_role('button',name='完成',exact=True).click()
        rows.filter(has_text='另一封邮件').click()
        expect(dialog).to_contain_text('另一封完整正文')
        page.evaluate('window.__finishMailDetail()')
        expect(dialog).to_contain_text('另一封完整正文')
        expect(dialog.locator('iframe')).to_have_count(0)
        assert not errors,errors
        print(f'PASS {engine}: HTML tables/styles/quotes, CID images, automatic external images, blocked active content, full headers, text toggle, attachment save, narrow layout, offline retry, stale-load isolation')
        browser.close()

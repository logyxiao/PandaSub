"""Local disk/text reads bypass busy network slots; Esc and queued confirmations respect their scope."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
BOOT=r'''const main=await(await fetch('/src/main.tsx')).text();
const React=(await import(main.match(/"([^"]*\/react\.js\?[^"]*)"/)[1])).default;
const {createRoot}=(await import(main.match(/"([^"]*\/react-dom_client\.js\?[^"]*)"/)[1])).default;
const host=document.createElement('div');document.body.append(host);const h=React.createElement;
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        errors=[]
        def page(extra=''):
            s=browser.new_page(viewport={'width':1280,'height':900})
            s.on('pageerror',lambda e:errors.append(str(e)))
            s.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+extra))
            s.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
            s.goto(os.environ['NOVELSUB_TEST_URL']);s.wait_for_load_state('networkidle');return s
        s=page()
        s.evaluate('async()=>{'+BOOT+r'''
          const {Modal}=await import('/src/components/Modal.tsx');const {Select}=await import('/src/components/ui.tsx');
          function Demo(){const [open,setOpen]=React.useState(true);return open?h(Modal,{title:'Esc 回归',onClose:()=>setOpen(false)},
          h(Select,{value:'a',options:[{value:'a',label:'A'},{value:'b',label:'B'}],onChange:()=>{},ariaLabel:'可搜索选项',searchable:true})):null}
          createRoot(host).render(h(Demo));
        }''')
        d=s.get_by_role('dialog',name='Esc 回归');expect(d).to_be_visible()
        trigger=d.get_by_role('button',name='可搜索选项',exact=True)
        trigger.click();s.get_by_role('textbox',name='搜索',exact=True).press('Escape')
        expect(s.get_by_role('listbox')).to_have_count(0);expect(d).to_be_visible();expect(trigger).to_be_focused()
        trigger.click();option=s.get_by_role('option',name='B',exact=True);option.focus();option.press('Escape')
        expect(s.get_by_role('listbox')).to_have_count(0);expect(d).to_be_visible();expect(trigger).to_be_focused()
        trigger.press('Escape');expect(d).to_have_count(0);s.close()

        for strict in [False,True]:
            s=page()
            s.evaluate('async()=>{'+BOOT+r'''
              const {ConfirmProvider,useConfirm}=await import('/src/components/feedback.tsx');
              function Demo(){const confirm=useConfirm();React.useEffect(()=>{window.__results=[];window.__ask=title=>confirm({title,message:title,confirmLabel:'确认 '+title,cancelLabel:'取消 '+title}).then(answer=>window.__results.push({title,answer}))},[confirm]);return null}
              const tree=h(ConfirmProvider,{},h(Demo));createRoot(host).render('''+('h(React.StrictMode,{},tree)' if strict else 'tree')+r''');
            }''')
            s.wait_for_function('typeof window.__ask === "function"')
            s.evaluate("void window.__ask('first')")
            expect(s.get_by_role('alertdialog',name='first',exact=True)).to_be_visible()
            s.evaluate("void window.__ask('second');void window.__ask('third')")
            first=s.get_by_role('button',name='确认 first',exact=True);first.focus();first.press('Enter')
            expect(s.get_by_role('button',name='取消 second',exact=True)).to_be_focused()
            s.keyboard.press('Enter')
            expect(s.get_by_role('button',name='取消 third',exact=True)).to_be_focused()
            s.keyboard.press('Escape');expect(s.get_by_role('alertdialog')).to_have_count(0)
            assert s.evaluate('window.__results')==[{'title':'first','answer':True},{'title':'second','answer':False},{'title':'third','answer':False}]
            s.close()

        s=page(r'''
          replies.splice(4);replies.forEach((r,i)=>{r.id=i+1;r.is_read=true;r.read_synced=true;serverSeen.set(r.id,true)});
          window.__network=[];window.__local=[];
          const detail=text=>({from:[],to:[],cc:[],bcc:[],reply_to:[],sent_at:'',text,html:'',inline_images:{},attachments:[],complete:true});
          functions.getLocalReplyContent=id=>{window.__local.push(id);return {...detail(id===3?'磁盘完整缓存 '+id:'本地旧正文 '+id),complete:id===3}};
          functions.getReplyContent=id=>{window.__network.push(id);return new Promise(resolve=>window['__finish'+id]=()=>resolve(detail('网络完整内容 '+id)))};
        ''')
        s.get_by_role('button',name='收件箱',exact=True).click()
        rows=s.locator('.reply-list-item');expect(rows).to_have_count(4)
        for i in range(2):
            rows.nth(i).click();s.wait_for_function('window.__network.length==='+str(i+1))
            s.get_by_role('dialog',name='邮件阅读').get_by_role('button',name='完成',exact=True).click()
        rows.nth(2).click();d=s.get_by_role('dialog',name='邮件阅读')
        expect(d.get_by_text('磁盘完整缓存 3',exact=True)).to_be_visible()
        expect(d.get_by_role('status')).to_have_count(0)
        assert s.evaluate('window.__network')==[1,2]
        d.get_by_role('button',name='完成',exact=True).click()
        rows.nth(3).click();expect(d.get_by_text('本地旧正文 4',exact=True)).to_be_visible()
        assert s.evaluate('window.__network')==[1,2]
        s.evaluate('window.__finish1()');s.wait_for_function('window.__network.length===3')
        assert s.evaluate('window.__network')==[1,2,4]
        s.evaluate('window.__finish4()');expect(d.get_by_text('网络完整内容 4',exact=True)).to_be_visible()
        s.evaluate('window.__finish2()');expect(d.get_by_text('网络完整内容 4',exact=True)).to_be_visible()
        s.close()
        assert not errors,errors
        print('PASS',engine,'disk/plain-text reads bypass network slots, scoped Escape, three queued confirmations reset cancel focus in normal/StrictMode',flush=True)
        browser.close()

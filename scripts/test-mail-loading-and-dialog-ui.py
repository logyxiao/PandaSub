"""Isolated regressions for bounded detail loading, server presets and modal focus scopes."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch(headless=True)
        errors = []
        def page(extra=''):
            s = browser.new_page(viewport={'width':1280,'height':900})
            s.on('pageerror', lambda e: errors.append(str(e)))
            s.route('**/src/api.ts*', lambda r:r.fulfill(content_type='application/javascript', body=MOCK+extra))
            s.route('**/src/update.ts*', lambda r:r.fulfill(content_type='application/javascript', body=UPDATE))
            s.goto(os.environ['NOVELSUB_TEST_URL']);s.wait_for_load_state('networkidle')
            return s
        s = page("functions.addAccount=input=>{window.__addedAccount=input};")
        s.get_by_role('button', name='邮箱管理', exact=True).click()
        for domain in ['qq.com','163.com','126.com','yeah.net']:
            s.get_by_role('button', name='添加邮箱', exact=True).first.click()
            d = s.get_by_role('dialog', name='配置投稿邮箱')
            d.get_by_label('邮箱地址', exact=True).fill('fixture@'+domain)
            d.get_by_label('授权码', exact=True).fill('fixture-not-a-real-secret')
            d.get_by_role('button', name='保存配置', exact=True).click()
            expect(d).to_have_count(0)
            saved = s.evaluate('window.__addedAccount')
            assert saved['smtp_host']=='smtp.'+domain and saved['imap_host']=='imap.'+domain, saved
        s.get_by_role('button', name='添加邮箱', exact=True).first.click()
        d = s.get_by_role('dialog', name='配置投稿邮箱')
        d.get_by_label('邮箱地址', exact=True).fill('fixture@custom.example')
        d.get_by_label('授权码', exact=True).fill('fixture')
        d.get_by_text('服务器设置', exact=True).click()
        d.get_by_label('根据邮箱地址自动配置', exact=True).uncheck()
        d.get_by_label('SMTP 服务器', exact=True).fill('smtp.enterprise.example')
        d.get_by_label('SMTP 端口', exact=True).fill('2465')
        d.get_by_label('IMAP 服务器', exact=True).fill('imap.enterprise.example')
        d.get_by_label('IMAP 端口', exact=True).fill('2993')
        d.get_by_label('邮箱地址', exact=True).fill('renamed@custom.example')
        d.get_by_role('button', name='取消', exact=True).focus()
        s.keyboard.press('Enter')
        guard = s.get_by_role('alertdialog', name='放弃未保存的修改？')
        expect(guard).to_be_visible()
        expect(guard.get_by_role('button',name='继续编辑',exact=True)).to_be_focused()
        for _ in range(8):
            s.keyboard.press('Tab')
            assert s.evaluate("!!document.activeElement.closest('[role=alertdialog]')")
        for _ in range(4):
            s.keyboard.press('Shift+Tab')
            assert s.evaluate("!!document.activeElement.closest('[role=alertdialog]')")
        assert s.locator('.app-shell').evaluate('el=>!!el.closest("[inert]")')
        s.keyboard.press('Escape')
        expect(guard).to_have_count(0)
        expect(d.get_by_role('button',name='取消',exact=True)).to_be_focused()
        expect(d.get_by_label('SMTP 端口',exact=True)).to_have_value('2465')
        d.get_by_role('button',name='保存配置',exact=True).click();expect(d).to_have_count(0)
        assert s.evaluate('window.__addedAccount.smtp_host')=='smtp.enterprise.example'
        assert s.evaluate('window.__addedAccount.imap_port')==2993
        assert s.locator('[inert]').count()==0
        s.close()

        s = page(r'''
        replies.splice(8);replies.forEach(r=>{r.is_read=true;r.read_synced=true;serverSeen.set(r.id,true)});
        window.__pendingContent=[];
        functions.getReplyContent=id=>new Promise(resolve=>window.__pendingContent.push({id,finish:()=>resolve({from:[],to:[],cc:[],bcc:[],reply_to:[],sent_at:'',text:'完整正文 '+id,html:'',inline_images:{},attachments:[],complete:true})}));
        ''')
        s.get_by_role('button',name='收件箱',exact=True).click()
        rows=s.locator('.reply-list-item');expect(rows).to_have_count(8)
        for i in range(8):
            rows.nth(i).click();d=s.get_by_role('dialog',name='邮件阅读');expect(d).to_be_visible()
            expect(d.get_by_role('status')).to_contain_text('正在加载完整邮件')
            if i<2:s.wait_for_function('window.__pendingContent.length==='+str(i+1))
            if i<7:d.get_by_role('button',name='完成',exact=True).click()
        assert s.evaluate('window.__pendingContent.length')==2
        s.evaluate('window.__pendingContent[0].finish()')
        s.wait_for_function('window.__pendingContent.length===3')
        assert s.evaluate('window.__pendingContent.map(x=>x.id)')==[305,304,298]
        s.evaluate('window.__pendingContent[2].finish()')
        expect(d.get_by_text('完整正文 298',exact=True)).to_be_visible()
        s.evaluate('window.__pendingContent[1].finish()')
        expect(d.get_by_text('完整正文 298',exact=True)).to_be_visible()
        d.get_by_role('button',name='完成',exact=True).click()
        s.close()

        # A shared dialog must include native selects and its portaled searchable menu.
        s = page()
        s.evaluate(r'''async()=>{
          const main=await (await fetch('/src/main.tsx')).text();
          const reactUrl=main.match(/"([^"]*\/react\.js\?[^"]*)"/)[1];
          const domUrl=main.match(/"([^"]*\/react-dom_client\.js\?[^"]*)"/)[1];
          const React=(await import(reactUrl)).default;
          const {createRoot}=(await import(domUrl)).default;
          const {Modal}=await import('/src/components/Modal.tsx');
          const {Select}=await import('/src/components/ui.tsx');
          const host=document.createElement('div');document.body.append(host);const h=React.createElement;
          function Harness(){const [open,setOpen]=React.useState(true);return open?h(Modal,{title:'焦点回归',onClose:()=>setOpen(false)},
            h('select',{'aria-label':'原生选择'},h('option',{},'甲')),
            h(Select,{value:'a',options:[{value:'a',label:'甲'},{value:'b',label:'乙'}],onChange:()=>{},ariaLabel:'可搜索选择',searchable:true}),
            h('a',{href:'#test'},'链接')):null}
          createRoot(host).render(h(Harness));
        }''')
        d=s.get_by_role('dialog',name='焦点回归');expect(d).to_be_visible()
        d.get_by_role('button',name='可搜索选择',exact=True).click()
        search=s.get_by_role('textbox',name='搜索',exact=True);expect(search).to_be_focused()
        search.fill('乙');s.get_by_role('option',name='乙',exact=True).click()
        for _ in range(8):
            s.keyboard.press('Tab')
            assert s.evaluate("!!document.activeElement.closest('[role=dialog]')")
        s.keyboard.press('Escape');expect(d).to_have_count(0)
        assert s.locator('[inert]').count()==0
        s.close()
        assert not errors,errors
        print('PASS',engine,'domain presets/manual servers, nested confirmation focus/inert/restore, portal/native selects and bounded latest mail loading',flush=True)
        browser.close()

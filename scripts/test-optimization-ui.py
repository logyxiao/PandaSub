"""Isolated regressions for lazy loading, staged attachments and template autosave; no real mail or DB."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
let nextAttachment=0;
functions.stageAttachment=async(bytes)=>{
 if (!(bytes instanceof Uint8Array)) throw new Error('Attachment must use binary IPC');
 const result={token:'staged-'+(++nextAttachment),word_count:new TextDecoder().decode(bytes).replace(/\s/g,'').length};
 if(window.__deferAttachment) await new Promise(resolve=>window.__finishAttachment=resolve);
 return result;
};
functions.saveDefaultMailTemplates=()=>{if(window.__failTemplate)throw new Error('fixture save failure')};
functions.addManuscript=()=>2;
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':850})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.clock.install()
    page.goto(os.environ.get('NOVELSUB_UI_URL','http://127.0.0.1:5179'))
    page.get_by_role('button',name='投稿计划',exact=True).click()
    expect(page.locator('.plans-table')).to_be_visible()
    assert not page.evaluate("window.__calls.some(c=>['getDefaultMailTemplates','listEditors','listEditorGroups'].includes(c.name))")
    assert page.evaluate("window.__calls.filter(c=>c.name==='listManuscripts').every(c=>c.args[0]===true)")
    page.get_by_role('button',name='新建计划',exact=True).click()
    expect(page.locator('.plan-desk')).to_be_visible()
    page.get_by_label('作品名称',exact=True).fill('优化回归')
    page.get_by_role('button',name='编辑',exact=True).click()
    field=page.get_by_label('邮件正文',exact=True)
    field.fill('')
    field.press_sequentially('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    assert page.evaluate("window.__calls.filter(c=>c.name==='saveDefaultMailTemplates').length")==0
    page.clock.fast_forward(450)
    page.wait_for_function("window.__calls.filter(c=>c.name==='saveDefaultMailTemplates').length===1")
    # Explicit close flushes even before the debounce timer fires, and a failed flush prevents leaving.
    page.evaluate('window.__failTemplate=true')
    field.fill('保存失败后应保留的正文')
    page.get_by_role('button',name='返回',exact=True).click()
    expect(page.locator('.plan-desk')).to_be_visible()
    expect(page.get_by_text('默认模板保存失败：Error: fixture save failure',exact=True)).to_be_visible()
    page.evaluate('window.__failTemplate=false')
    page.get_by_role('button',name='返回',exact=True).click()
    page.get_by_role('button',name='放弃修改',exact=True).click()
    expect(page.locator('.plans-table')).to_be_visible()
    page.get_by_role('button',name='新建计划',exact=True).click()
    expect(page.locator('.plan-desk')).to_be_visible()
    page.locator('.plan-desk input[type=file]').set_input_files({'name':'短篇.txt','mimeType':'text/plain','buffer':'你好 世界'.encode()})
    expect(page.locator('.plan-desk')).to_contain_text('短篇.txt')
    assert page.evaluate("window.__calls.find(c=>c.name==='stageAttachment').args[0] instanceof Uint8Array")
    # Oversized files are rejected before reading or invoking the backend.
    before=page.evaluate("window.__calls.filter(c=>c.name==='stageAttachment').length")
    page.evaluate("""()=>{const input=document.querySelector('.plan-desk input[type=file]');const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(25*1024*1024+1)],'too-large.txt'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));}""")
    expect(page.get_by_text('Error: 文稿不能为空，且不能超过 25 MB',exact=True)).to_be_visible()
    assert page.evaluate("window.__calls.filter(c=>c.name==='stageAttachment').length")==before
    page.get_by_role('button',name='保存草稿',exact=True).click()
    expect(page.locator('.plans-table')).to_be_visible()
    payload=page.evaluate("window.__calls.find(c=>c.name==='addManuscript').args[0]")
    assert payload['file_token']=='staged-1' and payload['file_data'] is None and payload['word_count']==4
    page.wait_for_function("window.__calls.some(c=>c.name==='releaseAttachment'&&c.args[0]==='staged-1')")
    # Finishing an upload after closing the wizard must release its token instead of mutating another draft.
    page.get_by_role('button',name='新建计划',exact=True).click()
    expect(page.locator('.plan-desk')).to_be_visible()
    page.evaluate('window.__deferAttachment=true')
    page.locator('.plan-desk input[type=file]').set_input_files({'name':'迟到.txt','mimeType':'text/plain','buffer':b'late'})
    page.wait_for_function("typeof window.__finishAttachment==='function'")
    page.get_by_role('button',name='返回',exact=True).click()
    expect(page.locator('.plans-table')).to_be_visible()
    page.evaluate('window.__finishAttachment()')
    page.wait_for_function("window.__calls.some(c=>c.name==='releaseAttachment'&&c.args[0]==='staged-2')")
    # Cancel while File.arrayBuffer is still pending: no binary transfer or backend parsing should start.
    page.evaluate("""()=>{
      const read=File.prototype.arrayBuffer;
      File.prototype.arrayBuffer=function(){
        if(this.name!=='慢读取.txt')return read.call(this);
        const file=this;return new Promise(resolve=>window.__finishFileRead=async()=>resolve(await read.call(file)));
      };
    }""")
    page.get_by_role('button',name='新建计划',exact=True).click()
    before=page.evaluate("window.__calls.filter(c=>c.name==='stageAttachment').length")
    page.locator('.plan-desk input[type=file]').set_input_files({'name':'慢读取.txt','mimeType':'text/plain','buffer':b'cancel before transfer'})
    page.wait_for_function("typeof window.__finishFileRead==='function'")
    page.get_by_role('button',name='返回',exact=True).click()
    expect(page.locator('.plans-table')).to_be_visible()
    page.evaluate('async()=>{await window.__finishFileRead();await Promise.resolve()}')
    assert page.evaluate("window.__calls.filter(c=>c.name==='stageAttachment').length")==before
    assert not errors,errors
    print('PASS: lazy plan resources, summary requests, 40 edits coalesced to 1 save, close flush and failure recovery, binary import, size limit, token-only save, release after save and cancelled upload')
    browser.close()

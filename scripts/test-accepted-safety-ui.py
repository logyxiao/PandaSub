"""Latest request wins, full editing detail, dirty forms, failures and navigation during writes."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
from accepted_ui_fixtures import ACCEPTED

EXTRA = r'''
for (let id=1;id<=2;id++) acceptedWorks.push({id,manuscript_id:null,source:'external',review_status:'accepted',
 title:'作品'+id,body:'仅详情加载的完整正文'+id,file_name:'作品'+id+'.txt',has_file:true,
 accepted_at:'2026-09-26',sold_at:'',deal_mode:'buyout',price_cents:10000,guarantee_cents:0,per_thousand_cents:0,
 realized_share_cents:0,monthly_settlements:[],share_percent:50,sale_platform:'平台',buyer_editor:'编辑',
 listing_platform:'',article_url:'',notes:'备注',record_origin:'manual',created_at:'',updated_at:''});
window.__previewResolvers={};window.__editResolvers={};
const previewBase=functions.getAcceptedWorkDocument, editBase=functions.getAcceptedWork, saveBase=functions.updateAcceptedWork;
functions.getAcceptedWorkDocument=async id=>{
 if(window.__deferPreview) await new Promise(resolve=>window.__previewResolvers[id]=resolve);
 if(window.__failPreview) throw new Error('preview failure');
 return {...previewBase(id),attachment_text:'后端提取的文稿'+id};
};
functions.getAcceptedWork=async id=>{
 const work=editBase(id);
 if(window.__deferEdit) await new Promise(resolve=>window.__editResolvers[id]=resolve);
 return work;
};
functions.updateAcceptedWork=async(id,input)=>{
 if(window.__deferSave) await new Promise(resolve=>window.__finishAcceptedSave=resolve);
 if(window.__failSave) throw new Error('save failure');
 return saveBase(id,input);
};
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+ACCEPTED+EXTRA))
    page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    nav=page.get_by_role('navigation',name='主导航')
    nav.get_by_role('button',name='过稿统计',exact=True).click()
    rows=page.locator('.accepted-table tbody tr')
    expect(rows).to_have_count(2)
    assert page.evaluate("window.__calls.filter(c=>['listAcceptedWorks','listManuscripts'].includes(c.name)).every(c=>c.args[0]===true)")
    assert not page.evaluate("window.__calls.some(c=>c.name==='getAcceptedWork'||c.name==='getAcceptedWorkDocument')")
    # A slower first document must not replace the more recently requested second document.
    page.evaluate('window.__deferPreview=true')
    rows.filter(has_text='作品1').get_by_role('button',name='查看文稿').click()
    rows.filter(has_text='作品2').get_by_role('button',name='查看文稿').click()
    page.wait_for_function("typeof window.__previewResolvers[1]==='function'&&typeof window.__previewResolvers[2]==='function'")
    page.evaluate('window.__previewResolvers[2]()')
    preview=page.get_by_role('dialog',name='文稿 · 作品2')
    expect(preview).to_contain_text('后端提取的文稿2')
    page.evaluate('window.__previewResolvers[1]()')
    expect(preview).to_be_visible()
    preview.get_by_role('button',name='关闭',exact=True).last.click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    assert not page.evaluate("window.__calls.some(c=>c.name==='extractDocx')")
    # Competing edit-detail requests follow the same latest-only rule.
    page.evaluate('window.__deferEdit=true')
    rows.filter(has_text='作品1').get_by_role('button',name='编辑',exact=True).click()
    rows.filter(has_text='作品2').get_by_role('button',name='编辑',exact=True).click()
    page.wait_for_function("typeof window.__editResolvers[1]==='function'&&typeof window.__editResolvers[2]==='function'")
    page.evaluate('window.__editResolvers[2]()')
    form=page.get_by_role('dialog',name='编辑核对记录 · 作品2')
    expect(form.get_by_label('文章正文')).to_have_value('仅详情加载的完整正文2')
    page.evaluate('window.__editResolvers[1]()')
    expect(form).to_be_visible()
    # Opening then cancelling an untouched record does not prompt.
    form.get_by_role('button',name='取消',exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(page.get_by_role('alertdialog')).to_have_count(0)
    page.evaluate('window.__deferEdit=false')
    rows.filter(has_text='作品2').get_by_role('button',name='编辑',exact=True).click()
    expect(form).to_be_visible()
    form.get_by_label('文章正文').fill('尚未保存的文稿修改')
    form.get_by_role('button',name='取消',exact=True).click()
    confirm=page.get_by_role('alertdialog')
    expect(confirm).to_contain_text('放弃未保存的修改')
    confirm.get_by_role('button',name='继续编辑').click()
    expect(form.get_by_label('文章正文')).to_have_value('尚未保存的文稿修改')
    # Navigation uses the same guard, and declining preserves the form.
    page.evaluate("document.querySelectorAll('.nav-item').forEach(b=>{if(b.textContent.trim()==='工作台')b.click()})")
    expect(confirm).to_be_visible()
    confirm.get_by_role('button',name='继续编辑').click()
    expect(form).to_be_visible()
    # Failed saves preserve the draft, and an in-flight save blocks navigation and edits.
    page.evaluate('window.__failSave=true')
    form.get_by_role('button',name='保存最终过稿记录').click()
    expect(page.get_by_text('Error: save failure',exact=True)).to_be_visible()
    expect(form.get_by_label('文章正文')).to_have_value('尚未保存的文稿修改')
    page.evaluate('window.__failSave=false;window.__deferSave=true')
    form.get_by_role('button',name='保存最终过稿记录').click()
    page.wait_for_function("typeof window.__finishAcceptedSave==='function'")
    expect(form.get_by_label('文章正文')).to_be_disabled()
    page.evaluate("document.querySelectorAll('.nav-item').forEach(b=>{if(b.textContent.trim()==='工作台')b.click()})")
    expect(page.get_by_text('正在保存，请稍候',exact=True)).to_be_visible()
    expect(form).to_be_visible()
    page.evaluate('window.__finishAcceptedSave()')
    expect(form).to_have_count(0)
    assert page.evaluate("window.__acceptedWorks.find(w=>w.id===2).body")=='尚未保存的文稿修改'
    # Explicit discard is required to switch a dirty new form's source.
    page.get_by_role('button',name='新增外部文章',exact=True).first.click()
    new_form=page.get_by_role('dialog',name='核对作品结果')
    new_form.get_by_label('作品名称').fill('草稿')
    new_form.get_by_role('button',name='软件内投稿',exact=True).click()
    expect(confirm).to_be_visible()
    confirm.get_by_role('button',name='继续编辑').click()
    expect(new_form.get_by_label('作品名称')).to_have_value('草稿')
    new_form.get_by_role('button',name='取消',exact=True).click()
    confirm.get_by_role('button',name='放弃修改').click()
    expect(new_form).to_have_count(0)
    # Results completing after leaving the page never resurrect a dialog.
    page.evaluate('window.__previewResolvers={};window.__deferPreview=true')
    rows.filter(has_text='作品1').get_by_role('button',name='查看文稿').click()
    page.wait_for_function("typeof window.__previewResolvers[1]==='function'")
    nav.get_by_role('button',name='工作台',exact=True).click()
    page.evaluate('window.__previewResolvers[1]()')
    expect(page.get_by_role('dialog')).to_have_count(0)
    assert not errors,errors
    print('PASS: summary-only list, on-demand full edit, server preview text, latest-only preview/edit, unmount cancellation, dirty close/source/navigation guards, failed-save recovery and busy protection')
    browser.close()

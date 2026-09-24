"""Panda application regression: actual React views, isolated in-memory API writes."""
import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE

EXTRA = r'''
const editors = [
 { id:1, name:'青竹', platform:'星河故事', email:'bamboo@example.com', work_type:['短篇','古言'], rejected_types:['校园'], notes:'收 1–3 万字古言。请附完整稿件及故事梗概。\n完整收稿要求：注明字数、笔名、联系方式；请勿重复投稿，审稿周期两周。', source:'默认数据', favorited:true },
 { id:2, name:'南山', platform:'青禾文学', email:'mountain@example.com', work_type:['短篇','现言'], rejected_types:[], notes:'都市情感、现实题材，正文请勿附网盘链接。', source:'手动数据', favorited:false },
 { id:3, name:'清和', platform:'拾光阅读', email:'light@example.com', work_type:['古言'], rejected_types:[], notes:'完整长篇优先，回复周期约 7 个工作日。', source:'默认数据', favorited:false },
 ...Array.from({length:16},(_,i)=>({id:i+4,name:'测试编辑'+(i+4),platform:'测试平台',email:'fixture'+i+'@example.com',work_type:['悬疑'],rejected_types:[],notes:'',source:'手动数据',favorited:false}))
].map(e=>({...e,enabled:true,created_at:'2026-09-24',updated_at:'2026-09-24'}));
const groups=[{id:1,name:'短篇常投',editor_ids:[1,2],created_at:'2026-09-24',updated_at:'2026-09-24'},{id:2,name:'重点跟进',editor_ids:[3],created_at:'2026-09-24',updated_at:'2026-09-24'}];
window.__editors=editors;window.__groups=groups;
Object.assign(functions,{
 listEditors:()=>editors.map(e=>({...e})),listEditorGroups:()=>groups.map(g=>({...g})),
 updateEditor:async(id,input)=>{if(window.__failSave)throw new Error('保存失败测试');if(window.__deferSave)await new Promise(resolve=>window.__finishSave=resolve);Object.assign(editors.find(e=>e.id===id),input,{source:'手动数据'})},
 addEditor:input=>{editors.push({...editors[0],...input,id:20,favorited:false});return 20},
 toggleEditorFavorite:id=>{const e=editors.find(e=>e.id===id);return e.favorited=!e.favorited},
 updateEditorGroup:(id,input)=>{if(window.__failGroup===id)throw new Error('编辑组保存失败');Object.assign(groups.find(g=>g.id===id),input)},
 createEditorGroup:input=>{const id=groups.length+1;groups.push({...input,id});return id},
});
const originalDashboard=functions.dashboard;
functions.dashboard=()=>({...originalDashboard(),tasks:[task,{...task,id:2,status:'completed'},{...task,id:3,status:'stopped'}]});
const originalGetStats=functions.getStats;
const dateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
functions.getStats=(start,end,group)=>{
 if(window.__statsStress){
  const rows=[{period:'2026-W01',deliveries:1234567,human_replies:987654,failures:12345,accepted:9876},{period:'2026-W02',deliveries:8,human_replies:0,failures:0,accepted:0}];
  return {groups:rows,totals:{deliveries:1234575,human_replies:987654,failures:12345,accepted:9876}};
 }
 if(group==='day' && end===dateKey(new Date()) && start){
  if(window.__failTrend)return Promise.reject(new Error('趋势读取失败测试'));
  const days=Math.round((new Date(end+'T12:00:00')-new Date(start+'T12:00:00'))/86400000)+1;
  const rows=[{period:start,deliveries:days===7?3:13,human_replies:1,accepted:0,failures:0},{period:end,deliveries:7,human_replies:2,accepted:0,failures:0}];
  const report={groups:rows,totals:{deliveries:days===7?10:20,human_replies:3,accepted:0,failures:0}};
  if(window.__deferTrend){window.__deferTrend=false;return new Promise(resolve=>window.__finishTrend=()=>resolve(report))}
  return report;
 }
 return originalGetStats(start,end,group);
};
replies[0].body='谢谢来稿，我们已阅读故事。\n请补充人物小传。\n\n> 这是原来的投稿正文';
'''
artifacts = Path(tempfile.mkdtemp(prefix='novelsub-panda-'))
with sync_playwright() as p:
    browser = getattr(p, os.environ.get('NOVELSUB_TEST_BROWSER', 'chromium')).launch(headless=True)
    page = browser.new_page(viewport={'width':1280,'height':900},reduced_motion='reduce')
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/src/api.ts*',lambda route:route.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
    page.route('**/src/update.ts*',lambda route:route.fulfill(content_type='application/javascript',body=UPDATE))
    page.route('**/*plugin-dialog*',lambda route:route.fulfill(content_type='application/javascript',body="export const save=async()=>null;"))
    page.goto(os.environ.get('NOVELSUB_TEST_URL','http://127.0.0.1:5179'))
    page.wait_for_load_state('networkidle')
    expect(page.locator('.stat')).to_have_count(4)
    expect(page.locator('.nav-item.active')).to_have_css('background-color','rgb(48, 57, 54)')
    expect(page.get_by_role('img',name='近 7 天成功投递 10 封，人工回复 3 封')).to_be_visible()
    page.get_by_role('button',name='近 30 天',exact=True).click()
    expect(page.get_by_role('img',name='近 30 天成功投递 20 封，人工回复 3 封')).to_be_visible()
    page.evaluate('window.__deferTrend=true')
    page.get_by_role('button',name='近 7 天',exact=True).click()
    page.wait_for_function("typeof window.__finishTrend==='function'")
    page.get_by_role('button',name='近 30 天',exact=True).click()
    expect(page.get_by_role('img',name='近 30 天成功投递 20 封，人工回复 3 封')).to_be_visible()
    page.evaluate('window.__finishTrend()')
    expect(page.get_by_role('img',name='近 30 天成功投递 20 封，人工回复 3 封')).to_be_visible()
    page.evaluate('window.__failTrend=true')
    page.get_by_role('button',name='近 7 天',exact=True).click()
    expect(page.locator('.dashboard-chart-error')).to_contain_text('趋势读取失败测试')
    expect(page.locator('.dashboard-live')).to_be_visible()
    page.evaluate('window.__failTrend=false')
    page.get_by_role('button',name='重试趋势',exact=True).click()
    expect(page.get_by_role('img',name='近 7 天成功投递 10 封，人工回复 3 封')).to_be_visible()
    page.locator('.dashboard-live').get_by_role('button',name='暂停',exact=True).click()
    expect(page.locator('.dashboard-live').get_by_role('button',name='继续',exact=True)).to_be_visible()
    page.locator('.dashboard-live').get_by_role('button',name='继续',exact=True).click()
    expect(page.locator('.dashboard-live').get_by_role('button',name='暂停',exact=True)).to_be_visible()
    assert page.locator('.brand-logo').get_attribute('src').endswith('/src/assets/logo.png')
    page.screenshot(path=str(artifacts/'dashboard.png'))
    nav=page.get_by_role('navigation',name='主导航')
    page.locator('.dashboard-reply-list > button').nth(1).click()
    expect(page.locator('.reply-reader h2')).to_have_text('回复304')
    nav.get_by_role('button',name='编辑库',exact=True).click()
    rows=page.locator('.library-table tbody tr')
    expect(rows).to_have_count(6)
    expect(page.locator('.pager-meta')).to_contain_text('共 19 条')
    page.screenshot(path=str(artifacts/'editors.png'))
    tags=page.locator('.library-tag-filter')
    tags.get_by_role('button',name='筛选标签短篇',exact=True).click()
    expect(rows).to_have_count(2)
    tags.get_by_role('button',name='筛选标签古言',exact=True).click()
    expect(rows).to_have_count(3)
    page.get_by_role('group',name='标签匹配方式').get_by_role('button',name='全部标签',exact=True).click()
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text('青竹')
    page.get_by_role('button',name='清空标签').click()
    expect(rows).to_have_count(6)
    # Filter editing is staged; inclusion and exclusion are explicit and removable.
    page.get_by_role('button',name='选择筛选标签',exact=True).click()
    picker=page.get_by_role('dialog',name='筛选收稿标签',exact=True)
    expect(picker.get_by_role('textbox',name='搜索筛选标签')).to_be_focused()
    picker.get_by_role('checkbox',name='选择标签短篇',exact=True).check()
    picker.get_by_role('button',name='排除标签古言',exact=True).click()
    expect(picker.locator('.tag-dialog-result')).to_have_text('匹配 1 位编辑')
    expect(rows).to_have_count(6)
    picker.get_by_role('button',name='取消',exact=True).click()
    expect(page.locator('.library-active-tags')).to_have_count(0)
    page.get_by_role('button',name='选择筛选标签',exact=True).click()
    picker.get_by_role('checkbox',name='选择标签短篇',exact=True).check()
    picker.get_by_role('button',name='排除标签古言',exact=True).click()
    page.screenshot(path=str(artifacts/'tag-filter.png'))
    picker.get_by_role('button',name='应用筛选',exact=True).click()
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text('南山')
    page.get_by_role('button',name='取消排除古言',exact=True).click()
    expect(rows).to_have_count(2)
    page.get_by_role('button',name='移除标签短篇',exact=True).click()
    expect(rows).to_have_count(6)
    page.get_by_role('textbox',name='搜索编辑库',exact=True).fill('南山')
    page.get_by_role('button',name='选择筛选标签',exact=True).click()
    expect(picker.locator('.tag-dialog-option').filter(has=page.get_by_role('checkbox',name='选择标签短篇',exact=True)).locator('small')).to_have_text('1')
    picker.get_by_role('textbox',name='搜索筛选标签').fill('不存在的标签')
    expect(picker.locator('.tag-dialog-empty')).to_be_visible()
    page.keyboard.press('Escape')
    page.get_by_role('textbox',name='搜索编辑库',exact=True).fill('')
    row=rows.filter(has_text='青竹')
    note=row.locator('.library-note')
    expect(note).to_have_css('white-space','nowrap')
    assert note.evaluate('e=>e.scrollWidth>e.clientWidth')
    note.hover()
    preview=page.get_by_role('tooltip')
    expect(preview).to_contain_text('完整收稿要求：注明字数、笔名、联系方式；请勿重复投稿，审稿周期两周。')
    expect(preview.locator('div')).to_have_css('white-space','pre-wrap')
    preview.hover()
    page.wait_for_timeout(180)
    expect(preview).to_be_visible()
    box=preview.bounding_box()
    assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=1280 and box['y']+box['height']<=900
    page.screenshot(path=str(artifacts/'note-preview.png'))
    page.keyboard.press('Escape')
    expect(preview).to_have_count(0)
    note.focus()
    expect(preview).to_be_visible()
    page.keyboard.press('Escape')
    expect(preview).to_have_count(0)
    row.get_by_role('button',name='编辑',exact=True).click()
    details=page.get_by_role('dialog',name='编辑资料',exact=True)
    expect(details).to_have_class('modal editor-drawer')
    expect(details.get_by_role('textbox',name='收稿邮箱（必填）')).to_have_value('bamboo@example.com')
    expect(page.get_by_role('textbox',name='修改投稿邮箱')).to_have_count(0)
    details.get_by_role('button',name='关闭',exact=True).click()
    row.locator('.library-email').dblclick()
    page.get_by_role('textbox',name='修改投稿邮箱').fill('MOUNTAIN@example.com')
    row.get_by_role('button',name='保存',exact=True).click()
    expect(page.locator('.toasts')).to_contain_text('这个邮箱已在编辑库中')
    assert page.evaluate("window.__calls.filter(c=>c.name==='updateEditor').length")==0
    page.get_by_role('textbox',name='修改投稿邮箱').fill('bamboo-new@example.com')
    row.get_by_role('button',name='选择收稿类型',exact=True).click()
    picker=page.get_by_role('dialog',name='选择收稿类型',exact=True)
    picker.get_by_role('textbox',name='搜索或新增标签',exact=True).fill('短篇、古言、短篇，幻想')
    picker.get_by_role('textbox',name='搜索或新增标签',exact=True).press('Enter')
    expect(picker.locator('.tag-dialog-selected')).to_contain_text('幻想')
    page.screenshot(path=str(artifacts/'tag-editor.png'))
    picker.get_by_role('textbox',name='搜索或新增标签').evaluate("(el,text)=>{const data=new DataTransfer();data.setData('text/plain',text);el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))}", '短篇\n幻想\n幻想')
    picker.get_by_role('textbox',name='搜索或新增标签').fill('中文输入中')
    picker.get_by_role('textbox',name='搜索或新增标签').evaluate("el=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))}")
    expect(picker).to_be_visible()
    expect(picker.locator('.tag-dialog-selected')).not_to_contain_text('中文输入中')
    picker.get_by_role('textbox',name='搜索或新增标签').fill('古')
    picker.get_by_role('button',name='确定标签',exact=True).click()
    expect(row.locator('.editor-tag-field')).to_contain_text('幻想')
    row.get_by_role('button',name='选择收稿类型',exact=True).click()
    picker=page.get_by_role('dialog',name='选择收稿类型',exact=True)
    picker.get_by_role('checkbox',name='选择标签短篇',exact=True).uncheck()
    page.keyboard.press('Escape')
    expect(picker).to_have_count(0)
    expect(page.get_by_role('textbox',name='修改投稿邮箱')).to_have_value('bamboo-new@example.com')
    expect(row.locator('.editor-tag-field')).to_contain_text('短篇')
    page.get_by_role('textbox',name='修改收稿备注').fill('新邮箱，收稿周期两周。')
    page.evaluate('window.__failSave=true')
    row.get_by_role('button',name='保存',exact=True).click()
    expect(page.locator('.toasts')).to_contain_text('保存失败测试')
    expect(page.get_by_role('textbox',name='修改收稿备注')).to_have_value('新邮箱，收稿周期两周。')
    page.evaluate('window.__failSave=false;window.__deferSave=true')
    page.get_by_role('textbox',name='修改收稿备注').press('Control+Enter')
    page.wait_for_function("typeof window.__finishSave==='function'")
    expect(row.get_by_role('button',name='保存中',exact=True)).to_be_disabled()
    nav.get_by_role('button',name='编辑组',exact=True).click()
    expect(page.locator('.page-heading h1')).to_have_text('编辑库')
    page.evaluate('window.__deferSave=false;window.__finishSave()')
    expect(page.get_by_role('textbox',name='修改投稿邮箱')).to_have_count(0)
    saved=page.evaluate('window.__editors[0]')
    assert saved['email']=='bamboo-new@example.com' and saved['work_type']==['短篇','古言','幻想']
    assert saved['rejected_types']==['校园'] and saved['name']=='青竹' and saved['platform']=='星河故事'
    page.get_by_role('tab',name='本次修改1',exact=True).click()
    expect(rows).to_have_count(1)
    page.get_by_role('tab',name='全部编辑19',exact=True).click()
    row.locator('.library-email').dblclick()
    page.get_by_role('textbox',name='修改收稿备注').fill('不应保存')
    nav.get_by_role('button',name='编辑组',exact=True).click()
    expect(page.get_by_role('alertdialog')).to_be_visible()
    page.get_by_role('button',name='继续编辑',exact=True).click()
    expect(page.get_by_role('textbox',name='修改收稿备注')).to_have_value('不应保存')
    page.get_by_role('textbox',name='修改收稿备注').press('Escape')
    expect(page.get_by_role('textbox',name='修改收稿备注')).to_have_count(0)
    assert page.evaluate('window.__editors[0].notes')=='新邮箱，收稿周期两周。'
    # Drawer cancel confirmation remains topmost when Escape is pressed.
    row.get_by_role('button',name='青竹',exact=True).click()
    dialog=page.get_by_role('dialog')
    expect(dialog).to_have_class('modal editor-drawer')
    dialog.get_by_role('textbox',name='名称',exact=True).fill('青竹新名字')
    page.screenshot(path=str(artifacts/'editor-drawer.png'))
    dialog.get_by_role('button',name='关闭',exact=True).click()
    expect(page.get_by_role('alertdialog')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.get_by_role('alertdialog')).to_have_count(0)
    expect(dialog).to_be_visible()
    dialog.get_by_role('button',name='关闭',exact=True).click()
    page.get_by_role('button',name='放弃修改',exact=True).click()
    expect(dialog).to_have_count(0)
    # Full drawer saves use the same API and appear in this session's changed view.
    row.get_by_role('button',name='青竹',exact=True).click()
    dialog.get_by_role('textbox',name='名称',exact=True).fill('青竹')
    dialog.get_by_role('button',name='选择收稿类型',exact=True).click()
    picker=page.get_by_role('dialog',name='选择收稿类型',exact=True)
    picker.get_by_role('textbox',name='搜索或新增标签').fill('新题材')
    picker.get_by_role('textbox',name='搜索或新增标签').press('Enter')
    picker.get_by_role('button',name='确定标签',exact=True).click()
    dialog.get_by_role('button',name='选择拒收类型',exact=True).click()
    picker=page.get_by_role('dialog',name='选择拒收类型',exact=True)
    picker.get_by_role('checkbox',name='选择标签新题材',exact=True).check()
    picker.get_by_role('button',name='确定标签',exact=True).click()
    expect(dialog.locator('.editor-tag-field').first).not_to_contain_text('新题材')
    expect(dialog.locator('.editor-tag-field').nth(1)).to_contain_text('新题材')
    dialog.get_by_role('textbox',name='收稿说明',exact=True).fill('完整资料保存的备注')
    dialog.get_by_role('button',name='保存',exact=True).click()
    expect(dialog).to_have_count(0)
    expect(row).to_contain_text('完整资料保存的备注')
    row.locator('.library-note').click()
    expect(page.get_by_role('textbox',name='修改收稿备注')).to_be_focused()
    page.keyboard.press('Escape')
    # Selection persists across pages and additions preserve existing members.
    page.get_by_role('checkbox',name='选择编辑青竹',exact=True).check()
    page.get_by_role('button',name='下一页',exact=True).click()
    expect(rows).to_have_count(6)
    rows.first.get_by_role('checkbox').check()
    selected_id=page.evaluate("Number(document.querySelector('.library-table tbody tr input').getAttribute('aria-label').match(/\\d+/)[0])")
    page.get_by_role('button',name='加入编辑组',exact=True).click()
    dialog.get_by_role('checkbox',name='短篇常投').check()
    dialog.get_by_role('checkbox',name='重点跟进').check()
    page.evaluate('window.__failGroup=2')
    dialog.get_by_role('button',name='确认加入',exact=True).click()
    expect(page.locator('.toasts')).to_contain_text('已保存 1 个组')
    expect(dialog.get_by_role('checkbox',name='短篇常投')).not_to_be_checked()
    page.evaluate('window.__failGroup=null')
    dialog.get_by_role('button',name='确认加入',exact=True).click()
    expect(dialog).to_have_count(0)
    assert page.evaluate('window.__groups[0].editor_ids')==[1,2,selected_id]
    assert page.evaluate('window.__groups[1].editor_ids')==[3,1,selected_id]
    nav.get_by_role('button',name='编辑组',exact=True).click()
    expect(page.locator('.page-heading h1')).to_have_text('编辑组')
    expect(page.locator('.editor-group-roster')).to_contain_text('青竹')
    page.screenshot(path=str(artifacts/'groups.png'))
    # Existing inbox supports selection, quote folding, full reading and pagination.
    nav.get_by_role('button',name='编辑回复',exact=True).click()
    expect(page.locator('.reply-list-item')).to_have_count(20)
    expect(page.locator('.reply-reader')).to_contain_text('请补充人物小传')
    expect(page.locator('.reply-quoted')).not_to_have_attribute('open','')
    page.get_by_text('展开引用的原邮件',exact=True).click()
    expect(page.locator('.reply-quoted')).to_have_attribute('open','')
    page.locator('.reply-list-item').nth(1).click()
    expect(page.locator('.reply-reader h2')).to_have_text('回复304')
    page.get_by_role('button',name='展开阅读',exact=True).click()
    expect(dialog).to_contain_text('回复内容304')
    page.keyboard.press('Escape')
    page.screenshot(path=str(artifacts/'replies.png'))
    # Fresh plan shortcut enters the established wizard only on request.
    nav.get_by_role('button',name='工作台',exact=True).click()
    page.get_by_role('button',name='新建投稿计划',exact=True).click()
    expect(page.locator('.plan-desk')).to_be_visible()
    page.screenshot(path=str(artifacts/'plan-wizard.png'))
    page.get_by_role('button',name='返回',exact=True).click()
    expect(page.locator('.plan-desk')).to_have_count(0)
    nav.get_by_role('button',name='工作台',exact=True).click()
    nav.get_by_role('button',name='投稿计划',exact=True).click()
    expect(page.locator('.plan-desk')).to_have_count(0)
    # Weekly labels and long numeric counts must stay within their own columns.
    page.evaluate('window.__statsStress=true')
    nav.get_by_role('button',name='投稿统计',exact=True).click()
    page.get_by_role('button',name='统计粒度',exact=True).click()
    page.get_by_role('option',name='按周统计',exact=True).click()
    expect(page.locator('.stats-table tbody tr').first).to_contain_text('2026 第 1 周')
    expect(page.locator('.stats-table tbody tr').first.locator('td').nth(1)).to_have_text('1,234,567')
    for size in [{'width':1280,'height':900},{'width':720,'height':560}]:
        page.set_viewport_size(size)
        assert page.locator('.stats-table').evaluate("""root => {
            const headers=[...root.querySelectorAll('th')];
            for(const row of root.querySelectorAll('tbody tr')) {
                for(const [index,cell] of [...row.cells].entries()) {
                    const box=cell.getBoundingClientRect(),head=headers[index].getBoundingClientRect();
                    if(Math.abs(box.x-head.x)>1 || Math.abs(box.width-head.width)>1) return false;
                    if(!cell.matches('.num,.mono')) continue;
                    const range=document.createRange();range.selectNodeContents(cell);
                    const text=range.getBoundingClientRect(),style=getComputedStyle(cell);
                    if(text.x<box.x+parseFloat(style.paddingLeft)-1 || text.right>box.right-parseFloat(style.paddingRight)+1) return false;
                }
            }
            return true;
        }"""), 'Statistics headers and numeric text must align with their cells'
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    page.set_viewport_size({'width':1280,'height':900})
    page.screenshot(path=str(artifacts/'stats-alignment.png'))
    page.evaluate('window.__statsStress=false')
    # Responsive shell has no document-level horizontal overflow.
    page.reload();page.wait_for_load_state('networkidle')
    for width,height in [(1280,900),(1280,872),(1180,760),(1180,732),(720,560)]:
        page.set_viewport_size({'width':width,'height':height})
        for label in ['工作台','编辑库','编辑组','编辑回复','邮箱管理','投稿计划','发送记录','投稿统计','设置','关于']:
            nav.get_by_role('button',name=label,exact=True).click()
            expect(page.locator('.page-heading h1')).to_have_text(label)
            expect(page.locator('.app-topbar')).to_have_count(0)
            assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),label
            if width==720: assert page.locator('.sidebar').bounding_box()['width']<=76
            if width>=1180:
                assert page.locator('.main').evaluate('e=>e.scrollHeight<=e.clientHeight && e.scrollWidth<=e.clientWidth'),label
                assert page.locator('.nav').evaluate('e=>e.scrollHeight<=e.clientHeight'),label
                if label in ['编辑库','发送记录','投稿统计','邮箱管理','投稿计划']:
                    for viewport in page.locator('.library-table-scroll,.ui-table-wrap').all():
                        assert viewport.evaluate('e=>e.scrollHeight<=e.clientHeight && e.scrollWidth<=e.clientWidth'),label
                if width==1280 and label=='工作台':
                    for viewport in page.locator('.dashboard-reply-list,.dashboard-recent-table-wrap,.dashboard-live,.stat').all():
                        assert viewport.evaluate('e=>e.scrollHeight<=e.clientHeight+1 && e.scrollWidth<=e.clientWidth+1'),viewport.get_attribute('class')
                for pager in page.locator('.pager').all():
                    box=pager.bounding_box()
                    assert box['y']+box['height']<=height,label
        nav.get_by_role('button',name='编辑库',exact=True).click()
        page.screenshot(path=str(artifacts/f'editors-{width}.png'))
    assert not errors, errors
    browser.close()
print('PASS: panda layout; OR/AND tags; duplicate validation; save failure recovery; save lock; keyboard editing; draft guards; drawer confirmation; cross-page selection; partial group failure recovery; persisted group members; inbox selection and quote folding; plan wizard; minimum window layout; no browser exceptions')
print('Screenshots:',artifacts)

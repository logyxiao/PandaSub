"""Removing editor tags must not move the dialog or scroll its ancestors."""
import os
from playwright.sync_api import sync_playwright, expect
from ui_fixtures import MOCK, UPDATE
EXTRA=r'''
const editor={...functions.listEditors()[0],work_type:['女频','民俗','短篇','纯爽','脑洞','古言','大女主','虐爽','追妻','世情','现言','小程序风','甜宠','追夫','男频','玄幻','UC风'],rejected_types:['校园','重生'],notes:'历史来源说明：'.repeat(100)+'\n平均回复时间：8 小时'};
functions.listEditors=()=>[{...editor}];
functions.updateEditor=(id,input)=>Object.assign(editor,input);
'''
with sync_playwright() as p:
    for engine in ['chromium','webkit']:
        browser=getattr(p,engine).launch(headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/src/api.ts*',lambda r:r.fulfill(content_type='application/javascript',body=MOCK+EXTRA))
        page.route('**/src/update.ts*',lambda r:r.fulfill(content_type='application/javascript',body=UPDATE))
        page.goto(os.environ['NOVELSUB_TEST_URL']);page.wait_for_load_state('networkidle')
        page.get_by_role('navigation',name='主导航').get_by_role('button',name='编辑库',exact=True).click()
        page.get_by_role('button',name='编辑甲',exact=True).click()
        dialog=page.get_by_role('dialog',name='编辑资料',exact=True)
        expect(dialog).to_be_visible()
        def snapshot():
            return dialog.evaluate('''e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,
                scroll:[...function*(node){for(;node;node=node.parentElement)yield node}(e)].map(n=>[n.className,n.scrollLeft,n.scrollWidth,n.clientWidth]),active:document.activeElement?.outerHTML.slice(0,150)})''')
        initial=snapshot()
        assert abs(initial['x']+initial['width']-1280)<1,initial
        for tag in ['女频','民俗','短篇','纯爽','脑洞','古言','大女主','虐爽','追妻','世情','现言','小程序风','甜宠','追夫','男频','玄幻','UC风']:
            dialog.get_by_role('button',name='移除标签'+tag,exact=True).click()
            page.wait_for_timeout(100)
            next=snapshot()
            assert abs(next['x']-initial['x'])<1,(initial,next)
        dialog.get_by_role('button',name='选择收稿类型',exact=True).click()
        picker=page.get_by_role('dialog',name='选择收稿类型',exact=True)
        expect(picker).to_be_visible()
        for tag in ['短篇','古言','女频']:
            picker.get_by_role('checkbox',name='选择标签'+tag,exact=True).check()
        base=picker.bounding_box()
        for tag in ['短篇','古言','女频']:
            picker.get_by_role('button',name='移除标签'+tag,exact=True).click()
            page.wait_for_timeout(100)
            assert abs(picker.bounding_box()['x']-base['x'])<1
        picker.get_by_role('button',name='确定标签',exact=True).click()
        expect(picker).to_have_count(0)
        assert abs(dialog.bounding_box()['x']-initial['x'])<1
        for width,height in [(960,650),(720,560)]:
            page.set_viewport_size({'width':width,'height':height})
            dialog.get_by_role('button',name='选择收稿类型',exact=True).click()
            for tag in ['短篇','古言','女频']:
                picker.get_by_role('checkbox',name='选择标签'+tag,exact=True).check()
            picker.get_by_role('button',name='确定标签',exact=True).click()
            for tag in ['短篇','古言','女频']:
                dialog.get_by_role('button',name='移除标签'+tag,exact=True).click()
                box=dialog.bounding_box()
                assert abs(box['x']+box['width']-width)<1,box
                assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.set_viewport_size({'width':1280,'height':900})
        dialog.get_by_role('button',name='取消排除校园',exact=True).click()
        assert abs(dialog.bounding_box()['x']-initial['x'])<1
        dialog.get_by_role('button',name='保存',exact=True).click()
        expect(dialog).to_have_count(0)
        saved=page.evaluate("window.__calls.filter(c=>c.name==='updateEditor').at(-1).args[1]")
        assert saved['work_type']==[] and saved['rejected_types']==['重生'],saved
        page.get_by_role('button',name='编辑甲',exact=True).click()
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('button',name='移除标签短篇',exact=True)).to_have_count(0)
        page.screenshot(path=f'/tmp/novelsub-editor-dialog-{engine}.png')
        assert not errors,errors
        browser.close()
        print(f'PASS {engine}: stable right drawer through repeated removals, nested picker, viewport changes, rejected tags and save/reopen')

"""过稿统计页面的隔离回归：模拟 Tauri 接口，不接触用户数据库。"""
import os
import base64
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from ui_fixtures import MOCK, UPDATE


EXTRA = r'''
const acceptedWorks=[];
const manuscripts=[m,{...m,id:2,title:'初审通过的故事'},{...m,id:3,title:'误判的回复'}];
const candidates=[
 {manuscript_id:1,title:'回归测试计划',received_at:'2026-09-25 12:00:00',sale_platform:'知乎盐选',buyer_editor:'编辑甲'},
 {manuscript_id:2,title:'初审通过的故事',received_at:'2026-09-24 10:00:00',sale_platform:'平台乙',buyer_editor:'编辑乙'},
 {manuscript_id:3,title:'误判的回复',received_at:'2026-09-23 10:00:00',sale_platform:'平台丙',buyer_editor:'编辑丙'}
];
window.__acceptedWorks=acceptedWorks;
m.file_name='原稿.docx';m.has_file=true;
Object.assign(functions,{
  listManuscripts:()=>manuscripts.map(item=>({...item})),
  listAcceptedWorks:()=>acceptedWorks.map(w=>({...w})),
  listAcceptedCandidates:()=>candidates.filter(c=>!acceptedWorks.some(w=>w.manuscript_id===c.manuscript_id)),
  addAcceptedWork:input=>{
    const source=manuscripts.find(item=>item.id===input.manuscript_id);
    const work={...input,id:acceptedWorks.length+1,title:input.source==='plan'?source.title:input.title,
      body:input.source==='plan'?source.body:input.body,file_name:input.source==='plan'?'原稿.docx':input.file_name,
      has_file:input.source==='plan'||!!input.file_data?.length,created_at:'2026-09-25',updated_at:'2026-09-25'};
    acceptedWorks.push(work);return work.id;
  },
  updateAcceptedWork:(id,input)=>{
    const work=acceptedWorks.find(w=>w.id===id);Object.assign(work,input,{has_file:input.remove_file?false:!!(input.file_data?.length||work.has_file)});
  },
  deleteAcceptedWork:id=>{acceptedWorks.splice(acceptedWorks.findIndex(w=>w.id===id),1)},
  getAcceptedWorkDocument:id=>{
    const work=acceptedWorks.find(w=>w.id===id);
    return {title:work.title,body:work.body,file_name:work.file_name,
      file_data:work.source==='plan'?[80,75,3,4]:work.file_data||null};
  },
  exportAcceptedWorkDocument:(id,path)=>{window.__exportedDocument={id,path};return path},
  openSavedDocument:(id,source,reveal)=>{window.__openedSaved={id,source,reveal};return '/tmp/submitted/原稿.docx'},
  saveAcceptedShareImage:(path,data)=>{window.__shareImage={path,data};return path},
  extractDocx:()=> '这是发送的 Word 文稿。\n第二段。',
});
'''

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1180, 'height': 760}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/src/api.ts*', lambda route: route.fulfill(content_type='application/javascript', body=MOCK + EXTRA))
    page.route('**/src/update.ts*', lambda route: route.fulfill(content_type='application/javascript', body=UPDATE))
    page.route('**/*plugin-dialog*', lambda route: route.fulfill(content_type='application/javascript', body="export const save=async(options)=>options.filters?.[0]?.extensions?.[0]==='png'?'/tmp/accepted-share.png':'/tmp/accepted-test.docx';"))
    page.goto(os.environ.get('NOVELSUB_TEST_URL', 'http://127.0.0.1:5179'))
    nav = page.get_by_role('navigation', name='主导航')
    assert nav.get_by_role('button', name='过稿统计').bounding_box()['y'] < nav.get_by_role('button', name='投稿统计').bounding_box()['y']
    nav.get_by_role('button', name='过稿统计').click()
    expect(page.get_by_text('待核对的邮件结果')).to_be_visible()
    expect(page.locator('.accepted-summary').get_by_text('0', exact=True).first).to_be_visible()
    page.screenshot(path='/tmp/novelsub-accepted-review-candidates.png')
    candidate = page.locator('.accepted-candidate').filter(has_text='回归测试计划')
    candidate.get_by_role('button', name='原稿文件夹').click()
    page.wait_for_function("window.__openedSaved?.id===1 && window.__openedSaved?.source==='manuscript' && window.__openedSaved?.reveal===true")
    candidate.get_by_role('button', name='打开 Word').click()
    page.wait_for_function("window.__openedSaved?.id===1 && window.__openedSaved?.source==='manuscript' && window.__openedSaved?.reveal===false")

    candidate.get_by_role('button', name='最终过稿').click()
    dialog = page.get_by_role('dialog', name='核对作品结果')
    expect(dialog.get_by_label('关联投稿计划')).to_have_value('1')
    expect(dialog.get_by_label('卖出平台')).to_have_value('知乎盐选')
    expect(dialog.get_by_role('group', name='核对结果').get_by_role('button', name='最终过稿')).to_have_attribute('aria-pressed', 'true')
    dialog.get_by_role('button', name='保底加分成').click()
    dialog.get_by_label('保底总价（元）').fill('3000.50')
    dialog.get_by_label('作者分成比例（%）').fill('47.5')
    dialog.get_by_label('已结算分成（元）').fill('200')
    expect(dialog.locator('input[type=date]')).to_have_count(1)
    expect(dialog.get_by_label('过稿日期')).not_to_have_value('')
    dialog.get_by_role('button', name='保存最终过稿记录').click()
    expect(page.locator('.accepted-table tbody tr')).to_have_count(1)
    expect(page.locator('.accepted-sales-table tbody tr')).to_have_count(1)
    assert page.evaluate('window.__acceptedWorks[0].guarantee_cents') == 300050
    assert page.evaluate('window.__acceptedWorks[0].realized_share_cents') == 20000
    assert page.evaluate('window.__acceptedWorks[0].share_percent') == 47.5

    page.locator('.accepted-candidate').filter(has_text='初审通过的故事').get_by_role('button', name='过初审').click()
    dialog = page.get_by_role('dialog', name='核对作品结果')
    expect(dialog.get_by_role('group', name='核对结果').get_by_role('button', name='过初审')).to_have_attribute('aria-pressed', 'true')
    dialog.get_by_role('button', name='保存过初审记录').click()
    page.locator('.accepted-candidate').filter(has_text='误判的回复').get_by_role('button', name='未过', exact=True).click()
    dialog = page.get_by_role('dialog', name='核对作品结果')
    expect(dialog.get_by_role('group', name='核对结果').get_by_role('button', name='未过稿')).to_have_attribute('aria-pressed', 'true')
    dialog.get_by_role('button', name='保存未过稿记录').click()
    expect(page.locator('.accepted-candidate')).to_have_count(0)
    assert page.evaluate("window.__acceptedWorks.map(w=>w.review_status)") == ['accepted','preliminary','not_accepted']
    assert page.locator('.accepted-summary > div').all_text_contents()[0].startswith('近 7 天卖出1')
    assert page.locator('.accepted-summary > div').all_text_contents()[1].startswith('近 30 天卖出1')
    expect(page.locator('.accepted-review-totals')).to_contain_text('初审通过 2 篇 · 最终过稿 1 篇 · 未过终审 0 篇 · 未过稿 1 篇')

    first_row = page.locator('.accepted-table tbody tr').filter(has_text='回归测试计划')
    first_row.get_by_role('button', name='打开文稿所在文件夹').click()
    page.wait_for_function("window.__openedSaved?.id===1 && window.__openedSaved?.source==='accepted' && window.__openedSaved?.reveal===true")
    first_row.get_by_role('button', name='查看文稿').click()
    preview = page.get_by_role('dialog', name='文稿 · 回归测试计划')
    expect(preview).to_contain_text('这是发送的 Word 文稿。')
    preview.screenshot(path='/tmp/novelsub-accepted-word-preview.png')
    preview.get_by_role('button', name='打开原稿').click()
    page.wait_for_function("window.__openedSaved?.source==='accepted' && window.__openedSaved?.reveal===false")
    preview.get_by_role('button', name='另存原稿').click()
    page.wait_for_function("window.__exportedDocument?.id===1")
    preview.get_by_role('button', name='关闭').last.click()

    page.get_by_role('button', name='新增外部文章').first.click()
    dialog = page.get_by_role('dialog', name='核对作品结果')
    dialog.get_by_label('作品名称').fill('外部上架小说')
    dialog.get_by_label('文章正文').fill('外部文章正文，可以继续编辑。')
    dialog.locator('input[type=file]').set_input_files({'name': '外部文稿.txt', 'mimeType': 'text/plain', 'buffer': '原始文本'.encode()})
    dialog.get_by_role('button', name='买断', exact=True).click()
    dialog.get_by_label('买断价格（元）').fill('5000')
    dialog.get_by_label('卖出平台').fill('番茄')
    dialog.get_by_label('卖家上架平台').fill('知乎')
    dialog.screenshot(path='/tmp/novelsub-accepted-form.png')
    dialog.get_by_role('button', name='保存最终过稿记录').click()
    expect(page.locator('.accepted-table tbody tr')).to_have_count(4)
    assert page.evaluate('window.__acceptedWorks[3].price_cents') == 500000
    expect(page.locator('.accepted-sales-table tbody tr')).to_have_count(2)
    assert page.locator('.accepted-summary > div').all_text_contents()[0].startswith('近 7 天卖出2')
    expect(page.locator('.accepted-summary > div').last).to_contain_text('¥8,200.5')
    page.screenshot(path='/tmp/novelsub-accepted-page.png')

    page.evaluate("""() => {
      window.__shareTexts = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(value, ...args) {
        window.__shareTexts.push(String(value));
        return original.call(this, value, ...args);
      };
    }""")
    page.get_by_role('button', name='分享成绩').click()
    share = page.get_by_role('dialog', name='分享成交记录')
    expect(share.locator('canvas')).to_be_visible()
    expect(share.locator('canvas')).to_have_attribute('data-ready', 'true')
    expect(share.locator('canvas')).to_have_attribute('aria-label', '熊猫投稿成交记录：近 7 天卖出 2 篇，近 30 天卖出 2 篇，累计成交 ¥8,200.5')
    assert page.evaluate("window.__shareTexts.includes('熊猫投稿') && window.__shareTexts.includes('成交记录')")
    assert not page.evaluate("window.__shareTexts.some(text => text.includes('回归测试计划') || text.includes('外部上架小说') || text.includes('编辑甲'))")
    assert page.evaluate("""() => {
      const canvas = document.querySelector('.accepted-share-canvas');
      const pixels = canvas.getContext('2d').getImageData(48, 43, 80, 80).data;
      let navy = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 45 && pixels[i+1] < 65 && pixels[i+2] < 90) navy++;
      return navy > 500;
    }""")
    share.get_by_role('button', name='放大查看').click()
    expect(share.locator('canvas')).to_have_class('accepted-share-canvas is-zoomed')
    share.get_by_role('button', name='适应窗口').click()
    share.locator('canvas').screenshot(path='/tmp/novelsub-accepted-share-card.png')
    share.get_by_role('button', name='保存 PNG 图片').click()
    page.wait_for_function("window.__shareImage?.data?.length>1000")
    assert page.evaluate('window.__shareImage.data.slice(0,8)') == [137,80,78,71,13,10,26,10]
    share.get_by_role('button', name='关闭').last.click()

    periods = page.evaluate("""async () => {
      const { summarizeAcceptedSales } = await import('/src/views/acceptedStats.ts');
      const base = { ...window.__acceptedWorks[0], review_status: 'accepted', deal_mode: 'buyout', price_cents: 10000, realized_share_cents: 0 };
      const dates = ['2026-09-25','2026-09-19','2026-09-18','2026-08-27','2026-08-26',''];
      const works = dates.map((accepted_at, id) => ({ ...base, id, accepted_at }));
      works.push({ ...base, id: 6, accepted_at: '2026-09-25', deal_mode: 'guarantee_share',
        price_cents: 0, guarantee_cents: 0, per_thousand_cents: 3000 });
      const summary = summarizeAcceptedSales(works, new Date(2026, 8, 25));
      return { sold: summary.soldCount, undated: summary.undatedSoldCount,
        unpriced: summary.unpricedSoldCount,
        seven: summary.last7Days, thirty: summary.last30Days,
        first: summary.dailyCumulative[0], last: summary.dailyCumulative[29] };
    }""")
    assert periods == {
        'sold': 7, 'undated': 1, 'unpriced': 1, 'seven': {'count': 3, 'cents': 20000},
        'thirty': {'count': 5, 'cents': 40000},
        'first': {'date': '2026-08-27', 'count': 1},
        'last': {'date': '2026-09-25', 'count': 5},
    }

    row = page.locator('.accepted-table tbody tr').filter(has_text='外部上架小说')
    row.get_by_role('button', name='编辑').click()
    dialog = page.get_by_role('dialog', name='编辑核对记录 · 外部上架小说')
    dialog.get_by_label('文章正文').fill('修订后的正文。')
    dialog.get_by_role('button', name='保存最终过稿记录').click()
    expect(page.locator('.accepted-table tbody tr')).to_have_count(4)
    assert page.evaluate('window.__acceptedWorks[3].body') == '修订后的正文。'
    row = page.locator('.accepted-table tbody tr').filter(has_text='外部上架小说')
    row.get_by_role('button', name='查看文稿').click()
    expect(page.get_by_role('dialog', name='文稿 · 外部上架小说')).to_contain_text('修订后的正文。')
    page.get_by_role('dialog', name='文稿 · 外部上架小说').get_by_role('button', name='关闭').last.click()
    page.locator('.accepted-table tbody tr').filter(has_text='初审通过的故事').get_by_role('button', name='编辑').click()
    dialog = page.get_by_role('dialog', name='编辑核对记录 · 初审通过的故事')
    dialog.get_by_role('group', name='核对结果').get_by_role('button', name='未过终审').click()
    dialog.get_by_role('button', name='保存未过终审记录').click()
    expect(page.locator('.accepted-summary > div').nth(0).locator('strong')).to_have_text('2')
    expect(page.locator('.accepted-review-totals')).to_contain_text('未过终审 1 篇 · 未过稿 1 篇')
    page.get_by_role('textbox', name='搜索过稿作品').fill('外部上架')
    expect(page.locator('.accepted-table tbody tr')).to_have_count(1)
    page.get_by_role('textbox', name='搜索过稿作品').fill('')
    page.get_by_role('group', name='核对状态筛选').get_by_role('button', name='未过终审').click()
    expect(page.locator('.accepted-table tbody tr')).to_have_count(1)
    expect(page.locator('.accepted-table tbody tr').filter(has_text='初审通过的故事')).to_have_count(1)
    page.get_by_role('group', name='核对状态筛选').get_by_role('button', name='未过稿').click()
    expect(page.locator('.accepted-table tbody tr')).to_have_count(1)
    expect(page.locator('.accepted-table tbody tr').filter(has_text='误判的回复')).to_have_count(1)

    page.evaluate("""() => {
      const base = window.__acceptedWorks[0];
      for (let i = 0; i < 6; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i - 1);
        const accepted_at = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
        window.__acceptedWorks.push({...base, id:100+i, manuscript_id:null, source:'external',
          title:'不可分享的作品名'+i, accepted_at, sale_platform:'渠道'+(i+1),
          record_origin:i===0?'historical_import':'manual',
          deal_mode:'buyout', price_cents:10000, guarantee_cents:0, per_thousand_cents:0, realized_share_cents:0});
      }
    }""")
    page.get_by_role('button', name='刷新过稿信息').click()
    page.get_by_role('button', name='分享成绩').click()
    share = page.get_by_role('dialog', name='分享成交记录')
    expect(share.locator('canvas')).to_have_attribute('data-ready', 'true')
    expect(share.locator('canvas')).to_have_attribute('height', '1080')
    share.locator('canvas').screenshot(path='/tmp/novelsub-accepted-share-eight.png')
    data_url = page.evaluate("document.querySelector('.accepted-share-canvas').toDataURL('image/png')")
    Path('/tmp/novelsub-accepted-share-eight-raw.png').write_bytes(base64.b64decode(data_url.split(',', 1)[1]))
    share.get_by_role('button', name='关闭').last.click()
    page.get_by_role('group', name='核对状态筛选').get_by_role('button', name='全部').click()
    page.get_by_label('记录来源筛选').select_option('historical_import')
    expect(page.locator('.accepted-table tbody tr')).to_have_count(1)
    expect(page.locator('.accepted-table tbody tr')).to_contain_text('历史导入')
    page.get_by_label('记录来源筛选').select_option('all')
    page.get_by_role('button', name='新增外部文章').first.click()
    dialog = page.get_by_role('dialog', name='核对作品结果')
    dialog.get_by_label('作品名称').fill('千字计价测试')
    dialog.get_by_role('button', name='保底加分成').click()
    dialog.get_by_label('千字单价（元）').fill('30')
    dialog.get_by_role('button', name='保存最终过稿记录').click()
    page.get_by_role('textbox', name='搜索过稿作品').fill('千字计价测试')
    expect(page.locator('.accepted-table tbody tr')).to_contain_text('¥30/千字')
    assert not errors, errors
    print('PASS: four review results, saved Word folder/open actions, sales table, PNG share card, external article, filtering and navigation')
    browser.close()

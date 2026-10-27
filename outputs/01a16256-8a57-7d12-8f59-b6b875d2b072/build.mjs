import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const raw = `九州云池2030312617 / 九州木子3490435214 / 九州三七3200497614 / 九州夏凉2474316128 / 九州浮生2362058397 / 九州薄荷1370850514
点众酸梅3361278505 / 点众菱岛178935503 / 点众耶耶1481338480 / 点众火星1239229361 / 点众落山2661106147
goodnovel长洲2489872143 / goodnovel菠萝2595389059 / goodnovel芒狗2901852438
dreame南冰1278805867 / dreame金桔226399218 / dreame咪妮3563047416
七猫水杉1724762504 / 七猫六咪3676240813 / 七猫山茶2037175640
掌心花满子3414679159 / 掌心长青3912300062 / 掌心遥遥2396083400
四季汤川2243904270 / 四季米猫2414541259 / 四季雨点3326329903
弦月伐木工2152822665 / 弦月金鱼3056707764 / 弦月月黎1731678276
洞洞猫洛洛1724189762 / 洞洞猫知月2746653329 / 洞洞猫小润3767997823
光芒北风2105591067 / 光芒珍珠1228115402 / 光芒胸毛2233659814
黑岩花椒597527161 / 黑岩瓜哥122689454 / 黑岩2h 9356045581
番茄九山1479546675 / 番茄小舟846152539 / 行舟水彩2539120880 / 行舟酒柒2801883400 / 果悦仙贝3649478271
果悦折也3137806961 / 简书回不回3169305331 / 简书星棠3176832372
墨墨珺璟3368167202 / 墨墨文商3592124348 / 月下莲子3269360646 / 月下声声2835009746
热岛梧秋3688582577 / 热岛崽崽2517419332 / 沐风金喜1307417900 / 浮月无机盐2485655464
17k娜娜3940590366 / 跃金巧克力椰3951303917 / 娃娃书屋雪碧兽323297597
风行晚风(海外)3239188698 / 炎旸星河2023650876 / 点文科技3697590325 / 云屿咩咩3927218819
烟流烟烟3976448966 / 今贝槿阳3955654623 / 星芒栀九2083708148 / 秉笔东东1394208054
知禾茶茶3118764741 / 万紫千蓝2993566298 / 绣球莓糕2082854406 / 云影阿辞2573038840
乐阅小柒1156559766 / 阅众子扬3099564410 / 硕才越越2052350263 / 天阅云裳1500979959 / 枫叶互动枝枝3273629193`;
const platforms = ['九州','点众','goodnovel','dreame','七猫','掌心','四季','弦月','洞洞猫','光芒','黑岩','番茄','行舟','果悦','简书','墨墨','月下','热岛','沐风','浮月','17k','跃金','娃娃书屋','风行','炎旸','点文科技','云屿','烟流','今贝','星芒','秉笔','知禾','万紫','绣球','云影','乐阅','阅众','硕才','天阅','枫叶互动'];
const entries = raw.split(/\s*\/\s*|\n/).filter(Boolean);
const rows = entries.map(entry => {
  const match = entry.match(/^(.*?)\s*(\d{5,})$/u);
  assert(match, entry);
  const [, label, qq] = match;
  const platform = platforms.find(p => label.startsWith(p));
  assert(platform, label);
  const name = label.slice(platform.length).trim() || label;
  const note = label === '点文科技' ? '原名单未提供编辑昵称，名称保留原称。' : '';
  return [platform, name, `${qq}@qq.com`, '', '', note];
});
assert.equal(rows.length, 74);
assert.equal(new Set(rows.map(r => r[2])).size, rows.length);
assert.deepEqual(rows.find(r => r[1] === '2h')?.slice(0, 3), ['黑岩','2h','9356045581@qq.com']);
assert.equal(rows.find(r => r[0] === '17k')?.[1], '娜娜');
assert.equal(rows.find(r => r[0] === '风行')?.[1], '晚风(海外)');
const data = [['平台','名称','邮箱','作品类型','拒收类型','收稿说明'], ...rows];
const dir = new URL('.', import.meta.url).pathname;
const workbook = Workbook.create();
const sheet = workbook.worksheets.add('编辑名单');
const last = data.length;
sheet.getRange(`A1:F${last}`).values = data;
sheet.showGridLines = false;
sheet.freezePanes.freezeRows(1);
sheet.getRange(`A1:F${last}`).format.font = { name: 'Arial', size: 11 };
sheet.getRange(`A1:F${last}`).format.rowHeight = 24;
sheet.getRange(`A1:F${last}`).format.verticalAlignment = 'center';
sheet.getRange(`A1:F${last}`).format.numberFormat = '@';
sheet.getRange(`A1:B${last}`).format.columnWidth = 18;
sheet.getRange(`C1:C${last}`).format.columnWidth = 29;
sheet.getRange(`D1:E${last}`).format.columnWidth = 16;
sheet.getRange(`F1:F${last}`).format.columnWidth = 57;
sheet.getRange('A1:F1').format = {fill:'#263C55',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},horizontalAlignment:'center',rowHeight:28};
for (let i = 2; i <= last; i += 2) sheet.getRange(`A${i}:F${i}`).format.fill = '#F1F5F9';
sheet.tables.add(`A1:F${last}`, true, 'EditorContacts');
workbook.recalculate();
assert.deepEqual(sheet.getRange(`A1:F${last}`).values, data);
console.log((await workbook.inspect({kind:'table',range:'编辑名单!A1:F5',include:'values',tableMaxRows:5,tableMaxCols:6,maxChars:1600})).ndjson);
const preview = await workbook.render({sheetName:'编辑名单',range:'A1:F12',scale:1.5,format:'png'});
await fs.writeFile(`${dir}preview.png`, new Uint8Array(await preview.arrayBuffer()));
await (await SpreadsheetFile.exportXlsx(workbook)).save(`${dir}编辑名单_74人_可导入.xlsx`);
await fs.writeFile(`${dir}expected.json`, JSON.stringify(data));
console.log(JSON.stringify({contacts:rows.length,platforms:new Set(rows.map(r=>r[0])).size,file:`${dir}编辑名单_74人_可导入.xlsx`}));

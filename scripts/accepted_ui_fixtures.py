"""Shared accepted-work fixtures: all document and mail operations stay mocked."""
ACCEPTED = r'''
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
  listManuscripts:(summary)=>manuscripts.map(item=>({...item,...(summary?{body:undefined,mail_templates:undefined}:{})})),
  getManuscript:(id)=>manuscripts.find(item=>item.id===id),
  listAcceptedWorks:(summary)=>acceptedWorks.map(w=>({...w,...(summary?{body:undefined}:{})})),
  getAcceptedWork:id=>({...acceptedWorks.find(w=>w.id===id)}),
  listAcceptedCandidates:()=>candidates.filter(c=>!acceptedWorks.some(w=>w.manuscript_id===c.manuscript_id)),
  addAcceptedWork:input=>{
    const source=manuscripts.find(item=>item.id===input.manuscript_id);
    const work={...input,id:acceptedWorks.length+1,title:input.source==='plan'?source.title:input.title,
      body:input.source==='plan'?source.body:input.body,file_name:input.source==='plan'?'原稿.docx':input.file_name,
      has_file:input.source==='plan'||!!(input.file_token||input.file_data?.length),created_at:'2026-09-25',updated_at:'2026-09-25'};
    acceptedWorks.push(work);return work.id;
  },
  updateAcceptedWork:(id,input)=>{
    const work=acceptedWorks.find(w=>w.id===id);Object.assign(work,input,{has_file:input.remove_file?false:!!(input.file_token||input.file_data?.length||work.has_file)});
  },
  deleteAcceptedWork:id=>{acceptedWorks.splice(acceptedWorks.findIndex(w=>w.id===id),1)},
  getAcceptedWorkDocument:id=>{
    const work=acceptedWorks.find(w=>w.id===id);
    return {title:work.title,body:work.body,file_name:work.file_name,
      has_file:work.has_file,attachment_text:work.source==='plan'?'这是发送的 Word 文稿。\n第二段。':work.has_file?'原始文本':''};
  },
  exportAcceptedWorkDocument:(id,path)=>{window.__exportedDocument={id,path};return path},
  openSavedDocument:(id,source,reveal)=>{window.__openedSaved={id,source,reveal};return '/tmp/submitted/原稿.docx'},
  saveAcceptedShareImage:(path,data)=>{window.__shareImage={path,data};return path},
  extractDocx:()=> '这是发送的 Word 文稿。\n第二段。',
});
'''


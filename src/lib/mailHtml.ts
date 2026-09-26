import DOMPurify from 'dompurify'

export function prepareMailHtml(html: string, inlineImages: Record<string, string>) {
  // Sanitize once into an inert DOM. Subsequent edits only move sanitized nodes or
  // assign explicitly validated URLs; no unsanitized markup is inserted.
  const root = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true, RETURN_DOM: true, USE_PROFILES: { html: true }, ADD_TAGS: ['style'],
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta', 'base'],
    FORBID_ATTR: ['srcset', 'background', 'action', 'formaction', 'autofocus'],
    ALLOW_DATA_ATTR: false,
  }) as HTMLElement
  const doc = root.ownerDocument
  const body = root.querySelector('body')!
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src')?.trim() ?? ''
    if (/^cid:/i.test(src)) {
      let cid = src.slice(4).replace(/^<|>$/g, '')
      try { cid = decodeURIComponent(cid) } catch { /* Keep malformed IDs as plain identifiers. */ }
      const data = inlineImages[cid]
      if (data && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(data)) img.setAttribute('src', data)
      else { img.removeAttribute('src'); img.setAttribute('alt', img.alt || '内嵌图片暂不可用') }
    } else if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
      img.setAttribute('src', src.startsWith('//') ? `https:${src}` : src)
    } else if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) img.removeAttribute('src')
    img.setAttribute('referrerpolicy', 'no-referrer')
    img.setAttribute('decoding', 'async')
  }
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    if (!/^(https?:\/\/|mailto:)/i.test(href)) link.removeAttribute('href')
    link.removeAttribute('target')
    link.removeAttribute('download')
    link.setAttribute('rel', 'noreferrer noopener')
  }
  for (const style of [...root.querySelectorAll('head style')].reverse()) body.prepend(style)
  const wrapper = doc.createElement('div')
  for (const attr of ['style', 'class', 'dir', 'lang']) { const value = body.getAttribute(attr); if (value) wrapper.setAttribute(attr, value) }
  while (body.firstChild) wrapper.appendChild(body.firstChild)
  const safe = wrapper.outerHTML
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  // Only this nonce-bearing bridge can execute, in an opaque sandbox origin.
  const bridge = `(function(){
    const token=${JSON.stringify(token)};
    const send=(type,value)=>window.parent.postMessage({channel:'mail-body',token,type,value},'*');
    let timer,lastHeight=0,lastWidth=window.innerWidth;
    const measure=()=>{clearTimeout(timer);timer=setTimeout(()=>{const root=document.body.firstElementChild;const height=Math.ceil(Math.max(root.scrollHeight+root.offsetTop,root.getBoundingClientRect().bottom+window.scrollY))+12;if(height!==lastHeight){lastHeight=height;send('height',height)}},16)};
    const click=event=>{const target=event.target.nodeType===1?event.target:event.target.parentElement;const link=target&&target.closest('a[href]');if(!link)return;event.preventDefault();const href=link.getAttribute('href');if(/^(https?:|mailto:)/i.test(href))send('link',href)};
    document.addEventListener('click',click);document.addEventListener('auxclick',click);
    document.addEventListener('load',measure,true);document.addEventListener('error',measure,true);document.addEventListener('toggle',measure,true);
    window.addEventListener('resize',()=>{if(window.innerWidth!==lastWidth){lastWidth=window.innerWidth;measure()}});
    window.addEventListener('message',event=>{if(event.source===window.parent&&event.data&&event.data.token===token&&event.data.type==='measure')measure()});
    measure();
  })();`
  const policy = `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; img-src data: https: http:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>html{background:#fff;color:#202124}body{margin:0;padding:4px;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{margin:12px 0;padding-left:14px;border-left:3px solid #ddd}a{color:#1769aa}*{box-sizing:border-box}</style></head><body>${safe}<script nonce="${token}">${bridge}</script></body></html>`
  return { document, token }
}

const BUILTINS = [
  {id:'glm',name:'GLM',url:'https://chatglm.cn/main/alltoolsdetail?lang=zh',color:'#5164d9',enabled:true,voting:true,custom:false,sendEvent:'mousedown',
    selectors:{input:'textarea.scroll-display-none',send:'.enter-icon-container .enter_icon',response:'.code-box > .answer-content-wrap:not(.text-advance-thinking-content) .markdown-body',responseRoot:'.answer-content',stop:'.enter.searching',done:'.interact-container .regenerate .shim.canuse',attachment:'.file-list-box-content-list > .file-list-box-content-item'}},
  {id:'deepseek',name:'DeepSeek',url:'https://chat.deepseek.com/',color:'#1679b7',enabled:true,voting:true,custom:false,
    selectors:{input:'textarea[placeholder*="DeepSeek"]',send:'._52c986b',response:'.ds-assistant-message-main-content',responseRoot:'[data-virtual-list-item-key]',stop:'._52c986b .ds-loading, ._52c986b:not(:has(path[d^="M8.3125 0.980206"]))',done:'.ds-message + .ds-flex',attachment:'.ds-animated-size-item > .d5fa3d1b'}},
  {id:'qwen',name:'千问',url:'https://www.qianwen.com/',color:'#8460bf',enabled:true,voting:true,custom:false,
    selectors:{input:'[contenteditable="true"][data-slate-editor="true"]',send:'button[aria-label="发送消息"]',response:'[data-chat-answers-wrap] .answer-common-card .qk-markdown',responseRoot:'[data-chat-answers-wrap]',stop:'button[aria-label="停止回答"]',done:'.answer-common-card .qk-markdown-complete',attachment:'[class^="imageThumbWrapper-"]'}},
  {id:'kimi',name:'Kimi',url:'https://www.kimi.com/',color:'#292a2d',enabled:true,voting:true,custom:false,
    selectors:{input:'.chat-input-editor[contenteditable="true"][data-lexical-editor="true"]',send:'.send-button-container:not(.disabled):not(.loading):not(.stop)',response:'.chat-content-item-assistant .toolcall-rollup__part > .markdown-container:not(.toolcall-content-text) > .markdown',responseRoot:'.chat-content-item-assistant[data-archer-id]',stop:'.send-button-container.stop',done:'.segment-assistant-actions svg[name="Refresh"]',attachment:'[data-testid="input-attachment-list"] .image-thumbnail'}}
];
export const SELECTOR_FIELDS = ['input','send','response','responseRoot','stop','done','attachment'];
export const BUILD = '1.0';
export const CONTENT_REVISION = 8;
export const defaults = () => structuredClone(BUILTINS);
export function migrateProviders(input,{addBuiltins=false}={}) {
  const providers=sanitizeProviders(input);
  for(const provider of providers) {
    if(provider.id==='glm'&&provider.selectors.send==='.enter-icon-container')provider.selectors.send='.enter-icon-container .enter_icon';
    if(['glm','deepseek'].includes(provider.id)&&!provider.selectors.stop)provider.selectors.stop=BUILTINS.find(builtin=>builtin.id===provider.id).selectors.stop;
    if(provider.id==='qwen'){
      const builtin=BUILTINS.find(item=>item.id==='qwen');
      if(provider.selectors.response==='[data-chat-answers-wrap] .qk-markdown')provider.selectors.response=builtin.selectors.response;
      if(['[data-answer-feedback-toolbar="true"]','.qk-markdown-complete'].includes(provider.selectors.done))provider.selectors.done=builtin.selectors.done;
    }
  }
  if(addBuiltins)for(const builtin of BUILTINS)if(providers.length<12&&!providers.some(provider=>provider.id===builtin.id))providers.push(...sanitizeProviders([builtin]));
  return providers;
}
export function originPattern(url) { return new URL(url).origin+'/*'; }
export function providerForUrl(providers,url) {
  try { const target=new URL(url); return providers.find(p=>new URL(p.url).origin===target.origin)||null; } catch { return null; }
}
export function sanitizeProviders(input) {
  if (!Array.isArray(input)||!input.length||input.length>12) throw Error('模型数量应为 1–12 个');
  const ids=new Set();
  return input.map(p=>{
    if (!p || !/^[a-z][a-z0-9_-]{1,39}$/.test(p.id||'')) throw Error('模型 ID 必须为 2–40 位英文字母、数字或连字符');
    if(ids.has(p.id)) throw Error('模型 ID 重复'); ids.add(p.id);
    let url; try {url=new URL(p.url);}catch {throw Error('模型网址无效');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname.includes('.')||/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)||url.hostname.endsWith('.localhost')) throw Error('模型网址必须为不含账号信息的公网 HTTPS 地址');
    const builtin=BUILTINS.find(b=>b.id===p.id);
    if(builtin&&new URL(builtin.url).origin!==url.origin) throw Error('不能修改内置模型的域名，请新增模型');
    const selectors={}; for(const field of SELECTOR_FIELDS) {
      const value=p.selectors?.[field]??builtin?.selectors[field]??'';
      if(typeof value!=='string'||value.length>1500) throw Error('页面选择器无效或过长');
      selectors[field]=value.trim();
    }
    const sendEvent=p.sendEvent??builtin?.sendEvent??'click';
    if(!['click','mousedown'].includes(sendEvent))throw Error('发送事件类型无效');
    return {id:p.id,name:String(p.name||p.id).trim().slice(0,40),url:url.href,color:/^#[0-9a-f]{6}$/i.test(p.color||'')?p.color:'#367d78',enabled:p.enabled!==false,voting:p.voting===true,custom:!builtin,sendEvent,selectors};
  });
}

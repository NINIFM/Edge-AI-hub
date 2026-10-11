import { validateQuestion, normalizeAnswer, recommend } from './core.mjs';
import { BUILD } from './providers.mjs';
const MIB=1024*1024;
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const STATUSES={idle:'等待回答',opening:'正在打开网页',sending:'正在发送',generating:'正在生成',needs_confirmation:'待人工确认',completed:'已完成',uncertain:'无法确认',error:'出现异常'};
const SELECTORS={input:'输入框',send:'发送按钮',response:'回答内容',responseRoot:'单轮回答容器',stop:'停止生成按钮',attachment:'已上传附件',done:'明确完成标记'};
const PREVIEW_PROVIDERS=[{id:'glm',name:'GLM',url:'https://chatglm.cn/',color:'#168779'},{id:'deepseek',name:'DeepSeek',url:'https://chat.deepseek.com/',color:'#5b76c6'},{id:'qwen',name:'千问',url:'https://www.qianwen.com/',color:'#8865b7'},{id:'kimi',name:'Kimi',url:'https://www.kimi.com/',color:'#292a2d'}].map(p=>({...p,enabled:true,voting:true,custom:false,selectors:{}}));
export function imageBatchErrors(existing,files){
  const errors=[];
  if(existing.length+files.length>4)errors.push('每题最多添加 4 张图片。');
  if(files.some(f=>!IMAGE_TYPES.has(f.type)))errors.push('仅支持 PNG、JPEG、WEBP 或 GIF 原图。');
  if(files.some(f=>!Number.isSafeInteger(f.size)||f.size<=0||f.size>8*MIB))errors.push('单张图片大小必须大于 0 且不超过 8 MiB。');
  if([...existing,...files].reduce((sum,f)=>sum+f.size,0)>20*MIB)errors.push('图片总大小不能超过 20 MiB。');
  return errors;
}
export function recommendationView(outcome){
  const titles={majority:'完整答案已达成多数',fallback:'无多数，参考 GLM',pending:'等待完整答案',incomplete:'本题结果不完整',no_voters:'没有参与投票的模型'};
  const valid=outcome.status==='majority'||outcome.status==='fallback';
  const provisional=!valid&&outcome.provisionalAnswer?` GLM 已完成答案：${outcome.provisionalAnswer}，仅供参考。`:'';
  return {title:titles[outcome.status]??'等待开始',reason:(outcome.reason??'')+provisional,answer:valid?outcome.answer:null,status:outcome.status};
}
function customOrigin(provider){
  let url;try{url=new URL(provider.url);}catch{throw Error('请填写有效的 HTTPS 网站地址。');}
  if(url.protocol!=='https:'||url.username||url.password)throw Error('自定义模型仅支持不带账号密码的 HTTPS 地址。');
  return url.origin+'/*';
}
export async function authorizeProviders(next,previous,permissions){
  const known=new Set(previous.filter(p=>p.custom).map(customOrigin));
  const origins=[...new Set(next.filter(p=>p.custom).map(customOrigin))].filter(origin=>!known.has(origin));
  if(!origins.length)return true;
  if(!permissions?.request)throw Error('当前环境不能申请网站权限；请在 Edge 扩展中保存新增模型。');
  return Boolean(await permissions.request({origins}));
}
function node(document,tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function button(document,text,className,action){const el=node(document,'button',className,text);el.type='button';el.addEventListener('click',action);return el;}
function safeColor(color){return /^#[0-9a-f]{6}$/i.test(color)?color:'#168779';}
export class Dashboard{
  constructor(document,api=globalThis.chrome??{}){
    this.document=document;this.api=api;this.preview=!api.runtime?.sendMessage;this.state={providers:[],run:null};
    this.images=[];this.questionType='auto';this.sentQuestion=null;this.cards=new Map();this.settingsDraft=[];this.imageLoading=false;this.starting=false;this.readingAnswers=false;
  }
  $(id){return this.document.getElementById(id);}
  feedback(message,error=true){const el=this.$('feedback');el.textContent=message;el.hidden=!message;el.className=error?'feedback error':'feedback';}
  async init(){
    this.bind();this.$('preview-notice').hidden=!this.preview;
    if(this.preview)this.setState({providers:PREVIEW_PROVIDERS.map(p=>({...p})),run:null});
    else{
      this.api.runtime.onMessage?.addListener(message=>{if(message?.type==='hub:state'&&message.state)this.setState(message.state);});
      await this.command('hub:get');
      const answerPoll=setInterval(()=>this.readAnswers(),1000);
      this.document.addEventListener('visibilitychange',()=>{if(!this.document.hidden)this.readAnswers();});
      this.document.defaultView?.addEventListener('pagehide',()=>clearInterval(answerPoll),{once:true});
    }
    this.render();
  }
  bind(){
    this.$('type-group').querySelectorAll('button').forEach(el=>el.addEventListener('click',()=>{if(this.state.run)return;this.questionType=el.dataset.type;this.renderEditor();}));
    this.$('question-text').closest('.composer').addEventListener('paste',event=>{
      if(this.state.run||this.imageLoading)return;
      const files=[...(event.clipboardData?.items??[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
      if(files.length){event.preventDefault();this.addImages(files);}
    });
    this.$('pastezone').addEventListener('click',()=>this.$('pastezone').focus());
    this.$('start-question').addEventListener('click',()=>this.start());this.$('start-manual').addEventListener('click',()=>this.start(true));
    this.$('clear-question').addEventListener('click',()=>this.clear());this.$('cancel-run').addEventListener('click',()=>this.command('hub:cancel'));
    this.$('settings-open').addEventListener('click',()=>this.openSettings());this.$('settings-close').addEventListener('click',()=>this.$('settings-dialog').close());
    this.$('add-provider').addEventListener('click',()=>{const id='m-'+(globalThis.crypto?.randomUUID?.()??Date.now().toString(36));this.settingsDraft.push({id,name:'新模型',url:'',color:'#168779',enabled:true,voting:false,custom:true,selectors:{}});this.renderSettings();});
    this.$('settings-form').addEventListener('submit',event=>{event.preventDefault();this.saveSettings();});
  }
  setState(state){if(!state||!Array.isArray(state.providers))return;if(state.run?.id!==this.state.run?.id)this.sentQuestion=null;if(['auto','single','multiple','judgment'].includes(state.run?.questionType))this.questionType=state.run.questionType;this.state=state;this.$('build-version').textContent=this.preview?`界面预览 ${BUILD}`:state.build===BUILD?`版本${BUILD}`:'后台未更新，请刷新扩展';this.render();}
  async command(type,payload={}){
    if(this.preview)return this.previewCommand(type,payload);
    try{const response=await this.api.runtime.sendMessage({type,...payload});if(!response?.ok)throw Error(response?.error??'扩展没有返回有效响应。');if(response.state)this.setState(response.state);return response;}
    catch(error){this.feedback(error.message??'操作失败，请重新打开扩展。');return {ok:false,error:error.message};}
  }
  async readAnswers(){
    if(this.preview||this.readingAnswers||!this.state.run||this.state.run.cancelled)return;
    this.readingAnswers=true;
    try{await this.command('hub:refresh');}finally{this.readingAnswers=false;}
  }
  previewCommand(type,payload){
    if(type==='hub:start'){
      this.state.run={id:'preview-'+Date.now(),questionType:payload.question.type,providers:this.state.providers.map(p=>({...p})),results:{}};
      this.state.run.providers.filter(p=>p.enabled).forEach(p=>{this.state.run.results[p.id]={status:'idle',text:'',source:'manual'};});
    }else if(type==='hub:clear')this.state.run=null;
    else if(type==='hub:manual'&&this.state.run)this.state.run.results[payload.providerId]={status:'completed',text:`最终答案：${payload.answer}`,answer:payload.answer,source:'manual'};
    else if(type==='hub:saveProviders')this.state.providers=payload.providers;
    else if(type==='hub:cancel'){this.feedback('手动汇总没有后台生成任务。',false);return {ok:true};}
    else{this.feedback('界面预览未连接模型网页；请在 Edge 中加载扩展后操作。');return {ok:false};}
    this.render();return {ok:true,state:this.state};
  }
  async addImages(files){
    if(this.state.run||this.imageLoading){this.feedback('请先点击“清空 / 下一题”再添加图片。');return;}if(!files.length)return;
    const errors=imageBatchErrors(this.images,files);if(errors.length){this.feedback(errors.join(' '));return;}
    this.imageLoading=true;this.renderEditor();
    try{
      const images=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{
        const reader=new this.document.defaultView.FileReader();reader.onload=()=>resolve({name:file.name||'粘贴截图.png',mime:file.type,size:file.size,dataUrl:reader.result});reader.onerror=()=>reject(Error('图片读取失败，请重新复制并粘贴截图。'));reader.readAsDataURL(file);
      })));
      const next={text:this.$('question-text').value,type:this.questionType,images:[...this.images,...images]};const validation=validateQuestion(next);if(validation.length)throw Error(validation.join(' '));
      this.images=next.images;this.renderImages();this.feedback('',false);
    }catch(error){this.feedback(error.message);}finally{this.imageLoading=false;this.renderEditor();}
  }
  async start(manualOnly=false){
    if(this.state.run||this.starting||this.imageLoading)return;if(this.preview&&!manualOnly){this.feedback('预览模式只支持手动汇总。');return;}
    const question={text:this.$('question-text').value.trim(),type:this.questionType,images:this.images.map(image=>({...image}))};
    const errors=validateQuestion(question);if(errors.length){this.feedback(errors.join(' '));return;}
    const providerIds=this.state.providers.filter(p=>p.enabled).map(p=>p.id);if(!providerIds.length){this.feedback('请先在模型设置中启用至少一个模型。');return;}
    this.starting=true;this.renderEditor();const response=await this.command('hub:start',{question,providerIds,...(manualOnly?{manualOnly:true}:{})});
    if(response.ok){this.sentQuestion=question;this.feedback(manualOnly?'本题已建立，可在各模型卡片中人工补录答案。':'已派发题目，请关注各模型的独立状态。',false);}
    this.starting=false;this.renderEditor();this.renderCards();
  }
  async retry(providerId){
    if(!this.sentQuestion){this.feedback('本题原始题目和图片不在当前面板内存中，请点击“清空 / 下一题”重新添加后发送。');return;}
    await this.command('hub:retry',{providerId,question:{...this.sentQuestion,images:this.sentQuestion.images.map(image=>({...image}))}});
  }
  async clear(){if(this.imageLoading||this.starting)return;const response=await this.command('hub:clear');if(response.ok){this.sentQuestion=null;this.images=[];this.$('question-text').value='';this.renderImages();this.feedback('',false);this.render();this.$('question-text').focus();}}
  async manual(providerId){
    const card=this.cards.get(providerId);if(!card||!this.state.run)return;const answer=normalizeAnswer(card.querySelector('.manual-input').value,this.state.run.questionType);
    if(!answer){this.feedback(this.state.run.questionType==='auto'?'请填写完整答案：A、AC 等完整选项组合，或正确 / 错误。':'请填写完整答案：单选填写一个字母，多选填写全部字母，判断填写正确或错误。');return;}
    if(!card.querySelector('.manual-confirm').checked){this.feedback('请勾选“我已核对并确认本答案”，再提交人工答案。');return;}
    await this.command('hub:manual',{providerId,answer});
  }
  render(){this.renderEditor();this.renderCards();this.renderRecommendation();}
  renderEditor(){
    const locked=Boolean(this.state.run)||this.starting||this.imageLoading;this.$('question-text').disabled=locked;
    this.$('type-group').querySelectorAll('button').forEach(el=>{el.disabled=locked;el.setAttribute('aria-pressed',String(el.dataset.type===(this.state.run?.questionType??this.questionType)));});
    this.$('start-manual').disabled=locked;this.$('start-question').disabled=locked||this.preview;
    this.$('settings-open').disabled=Boolean(this.state.run)||this.starting;this.$('clear-question').disabled=this.imageLoading||this.starting;
    this.$('pastezone').classList.toggle('locked',locked);this.$('pastezone').setAttribute('aria-disabled',String(locked));this.$('image-previews').querySelectorAll('button').forEach(el=>el.disabled=locked);
    this.$('composer-hint').textContent=this.imageLoading?'正在读取原图…':this.state.run?'清空会停止本题，下一题继续使用原会话。':this.preview?'界面预览：可手动汇总，网页发送不可用。':'各模型在原会话连续答题；截图直接 Ctrl+V。';
    this.$('cancel-run').hidden=this.preview||!Object.values(this.state.run?.results??{}).some(r=>['opening','sending','generating'].includes(r.status));
  }
  renderImages(){
    const host=this.$('image-previews');host.replaceChildren();
    this.images.forEach((image,index)=>{
      const figure=node(this.document,'figure','image-preview');const img=node(this.document,'img');img.src=image.dataUrl;img.alt=`原图 ${index+1}：${image.name}`;
      const caption=node(this.document,'figcaption');caption.append(node(this.document,'span','image-name',image.name),node(this.document,'small','',`${(image.size/MIB).toFixed(2)} MiB`));
      const remove=button(this.document,'×','remove-image',()=>{if(this.state.run)return;this.images.splice(index,1);this.renderImages();});remove.setAttribute('aria-label',`移除 ${image.name}`);
      figure.append(img,caption,remove);host.append(figure);
    });this.renderEditor();
  }
  makeCard(provider){
    const d=this.document;const card=node(d,'article','provider-card panel');card.dataset.providerId=provider.id;
    const heading=node(d,'div','provider-heading');const identity=node(d,'div','provider-identity');identity.append(node(d,'span','provider-symbol'),node(d,'h3','provider-name'));heading.append(identity,node(d,'span','provider-status'));
    const meta=node(d,'div','provider-meta');meta.append(node(d,'span','vote-label'),node(d,'span','source-label'));
    const answer=node(d,'div','provider-answer');answer.append(node(d,'span','answer-label','完整答案'),node(d,'strong','answer-value'));
    const note=node(d,'p','result-note');const error=node(d,'p','provider-error');error.setAttribute('role','status');
    const actions=node(d,'div','card-actions');
    actions.append(button(d,'打开网页 ↗','text-button open-provider',()=>this.command('hub:open',{providerId:provider.id})),button(d,'重试本模型','text-button retry-provider',()=>this.retry(provider.id)),button(d,'确认网页已完成','button secondary confirm-provider',()=>this.command('hub:confirm',{providerId:provider.id})));
    const details=node(d,'details','manual-entry');details.append(node(d,'summary','','人工补录答案'));
    const label=node(d,'label','manual-label','完整答案');const input=node(d,'input','manual-input');input.type='text';input.maxLength=20;input.autocomplete='off';label.append(input);
    const checkLabel=node(d,'label','check-label');const check=node(d,'input','manual-confirm');check.type='checkbox';checkLabel.append(check,d.createTextNode('我已核对并确认本答案'));
    details.append(label,checkLabel,button(d,'提交人工答案','button secondary manual-submit',()=>this.manual(provider.id)),node(d,'small','','人工答案会覆盖本模型结果，并明确标记来源。'));
    card.append(heading,meta,answer,note,error,actions,details);return card;
  }
  renderCards(){
    const run=this.state.run;const providers=this.state.providers;const ids=new Set(providers.map(p=>p.id));
    this.cards.forEach((card,id)=>{if(!ids.has(id)){card.remove();this.cards.delete(id);}});
    providers.forEach(provider=>{
      let card=this.cards.get(provider.id);if(!card){card=this.makeCard(provider);this.cards.set(provider.id,card);this.$('provider-cards').append(card);}
      if(card.dataset.runId!==(run?.id??'')){card.querySelector('.manual-input').value='';card.querySelector('.manual-confirm').checked=false;card.dataset.runId=run?.id??'';}
      const result=run?.results?.[provider.id];const enabled=run?Boolean(run.providers?.find(p=>p.id===provider.id)?.enabled):provider.enabled;
      card.style.setProperty('--provider-color',safeColor(provider.color));card.classList.toggle('disabled',!enabled);card.querySelector('.provider-symbol').textContent=provider.name.slice(0,1);card.querySelector('.provider-name').textContent=provider.name;
      const status=enabled?(result?.status??'idle'):'disabled';
      const valid=['generating','needs_confirmation','completed'].includes(status)?normalizeAnswer(result?.answer,run?.questionType):null;
      const captured=status==='generating'&&Boolean(valid);
      const statusElement=card.querySelector('.provider-status');statusElement.textContent=enabled?(result?.readDelayed?'读取延迟':captured?'已捕获答案':STATUSES[status]??'状态未知'):'未启用';statusElement.dataset.status=captured?'captured':status;
      card.querySelector('.vote-label').textContent=provider.voting?'参与投票':'仅供参考';card.querySelector('.source-label').textContent=result?.source==='manual'?'人工补录':result?.source==='auto'&&valid?'网页直接捕获':'使用官方网页';
      const note=card.querySelector('.result-note');note.hidden=status==='completed';
      note.textContent=!enabled?'在模型设置中启用后即可使用。':status==='sending'?'正在准备发送；上一题仍在生成时，会先停止再发送新题。':status==='needs_confirmation'?'请打开原网页核对本题回复，再确认或补录答案。':status==='uncertain'?'模型无法确认本题，完整回复可在原网页查看。':status==='error'?'请打开原网页检查，或重试本模型。':captured?'已读取本题答案，继续检查后续更正；完成后计入汇总。':run?'正在直接读取本题网页，识别到明确答案即显示。':'发送题目后，这里显示捕获到的答案。';
      card.querySelector('.answer-label').textContent=captured?'当前捕获':'完整答案';card.querySelector('.answer-value').textContent=valid??'—';card.querySelector('.provider-answer').classList.toggle('has-answer',Boolean(valid));
      card.querySelector('.provider-error').textContent=result?.error||(result?.status==='uncertain'?'模型已结束，但本题无法确认；此回复不参与投票。':result?.status==='completed'&&!valid?'已确认完成，但无法提取有效完整答案。':'');card.querySelector('.provider-error').hidden=!card.querySelector('.provider-error').textContent;
      card.querySelector('.open-provider').disabled=this.preview;card.querySelector('.retry-provider').hidden=!enabled||!run;card.querySelector('.retry-provider').disabled=this.preview||!this.sentQuestion||['opening','sending','generating'].includes(result?.status);
      card.querySelector('.retry-provider').title=!this.sentQuestion?'重新打开的面板缺少原始题目，请清空后重新发送。':'在本模型原会话中重发本题原文和原图';
      card.querySelector('.confirm-provider').hidden=result?.status!=='needs_confirmation';card.querySelector('.confirm-provider').disabled=this.preview||!valid;
      card.querySelector('.manual-input').placeholder=(run?.questionType??this.questionType)==='auto'?'A / AC / 正确 / 错误':(run?.questionType??this.questionType)==='judgment'?'正确 / 错误':(run?.questionType??this.questionType)==='multiple'?'例如 AC':'例如 A';
      card.querySelectorAll('.manual-input,.manual-confirm,.manual-submit').forEach(el=>el.disabled=!enabled||!run);
    });
    const results=Object.values(run?.results??{});
    const completed=results.filter(r=>r.status==='completed'&&normalizeAnswer(r.answer,run?.questionType)).length;
    const captured=results.filter(r=>['generating','needs_confirmation','completed'].includes(r.status)&&normalizeAnswer(r.answer,run?.questionType)).length;
    const uncertain=results.filter(r=>r.status==='uncertain').length;
    this.$('run-summary').textContent=run?`已捕获 ${captured} / ${run.providers.filter(p=>p.enabled).length} · 已完成 ${completed}${uncertain?` · ${uncertain} 家无法确认`:''}`:`${providers.filter(p=>p.enabled).length} 个模型已启用`;
  }
  renderRecommendation(){
    const run=this.state.run;const view=run?recommendationView(recommend(run.results,run.providers)):{title:'等待开始',reason:'生成中的回答不会参与投票，确认完成后才计入。',answer:null,status:'idle'};
    this.$('recommendation-title').textContent=view.title;this.$('recommendation-reason').textContent=view.reason;this.$('recommendation-answer').textContent=view.answer??'';this.$('recommendation-answer').hidden=!view.answer;this.$('recommendation').dataset.status=view.status;
  }
  openSettings(){this.settingsDraft=this.state.providers.map(p=>({...p,selectors:{...p.selectors}}));this.renderSettings();this.$('settings-feedback').textContent='';this.$('settings-dialog').showModal();}
  settingsField(host,label,value,key,provider,options={}){
    const el=node(this.document,'label','setting-field',label);const input=node(this.document,'input');input.type=options.type??'text';input.value=value??'';input.readOnly=Boolean(options.readOnly);input.maxLength=options.maxLength??2000;
    input.addEventListener('input',()=>{if(key.startsWith('selectors.'))provider.selectors[key.slice(10)]=input.value;else provider[key]=input.value;});el.append(input);host.append(el);return el;
  }
  renderSettings(){
    const d=this.document;const host=this.$('settings-providers');host.replaceChildren();
    this.settingsDraft.forEach(provider=>{
      const section=node(d,'section','provider-setting');const top=node(d,'div','setting-top');top.append(node(d,'strong','',provider.name));if(provider.custom)top.append(button(d,'移除','text-button danger',()=>{this.settingsDraft=this.settingsDraft.filter(p=>p.id!==provider.id);this.renderSettings();}));section.append(top);
      const grid=node(d,'div','settings-grid');this.settingsField(grid,'显示名称',provider.name,'name',provider,{maxLength:40});this.settingsField(grid,'官方网站（HTTPS）',provider.url,'url',provider,{readOnly:!provider.custom,type:'url'});this.settingsField(grid,'标识颜色',safeColor(provider.color),'color',provider,{type:'color'});section.append(grid);
      const toggles=node(d,'div','setting-toggles');[['enabled','启用模型'],['voting','参与投票']].forEach(([key,label])=>{const wrapper=node(d,'label','check-label');const input=node(d,'input');input.type='checkbox';input.checked=Boolean(provider[key]);input.addEventListener('change',()=>provider[key]=input.checked);wrapper.append(input,d.createTextNode(label));toggles.append(wrapper);});section.append(toggles);
      const details=node(d,'details','selector-settings');details.append(node(d,'summary','','页面控件与校准'));const selectors=node(d,'div','selector-grid');
      Object.entries(SELECTORS).forEach(([field,label])=>{
        const wrapper=this.settingsField(selectors,label,provider.selectors?.[field]??'','selectors.'+field,provider);
        const calibrate=button(d,'网页点选','text-button',async()=>{const response=await this.command('hub:calibrate',{providerId:provider.id,field});if(response.ok)this.$('settings-feedback').textContent='已打开网页点选校准。完成后关闭并重新打开设置，查看已保存控件。';});
        calibrate.disabled=this.preview||!this.state.providers.some(p=>p.id===provider.id);wrapper.append(calibrate);
      });details.append(selectors);section.append(details);host.append(section);
    });
  }
  async saveSettings(){
    const feedback=this.$('settings-feedback');feedback.textContent='';if(this.state.run){feedback.textContent='请先清空当前题目，再调整模型设置。';return;}
    try{
      const next=this.settingsDraft.map(p=>({...p,name:p.name.trim(),url:p.url.trim(),selectors:{...p.selectors}}));if(next.some(p=>!p.name||!p.url))throw Error('请填写每个模型的名称和网站地址。');
      const authorized=await authorizeProviders(next,this.state.providers,this.api.permissions);if(!authorized){feedback.textContent='未取得网站授权，模型设置尚未保存。';return;}
      this.$('save-settings').disabled=true;const response=await this.command('hub:saveProviders',{providers:next});if(response.ok){this.$('settings-dialog').close();this.feedback('模型设置已保存。',false);}else feedback.textContent=response.error??'设置保存失败。';
    }catch(error){feedback.textContent=error.message;}finally{this.$('save-settings').disabled=false;}
  }
}
if(typeof document!=='undefined'&&document.getElementById('provider-cards')){const dashboard=new Dashboard(document);dashboard.init().catch(error=>dashboard.feedback(error.message));}

import {defaults,sanitizeProviders,migrateProviders,originPattern,SELECTOR_FIELDS,BUILD,CONTENT_REVISION} from './providers.mjs';
import {validateQuestion,buildPrompt,extractAnswer,isUncertainResponse} from './core.mjs';

const clone=v=>structuredClone(v);
const terminal=r=>['completed','uncertain','error'].includes(r.status);
const needsPolling=r=>!terminal(r)&&!r.replyFinished;
const submissionsSettled=task=>task&&!task.cancelled&&Object.values(task.results).every(r=>r.submitted||terminal(r));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function conversationKey(id,value){
  const url=new URL(value);
  if(id==='glm')return url.searchParams.get('cid');
  const routes={deepseek:/^\/a\/chat\/s\/([^/]+)\/?$/,qwen:/^\/chat\/([^/]+)\/?$/,step:/^\/chats\/(?!new\/?$)([^/]+)\/?$/,hunyuan:/^\/chat\/([^/]+\/[^/]+)\/?$/};
  return routes[id]?url.pathname.match(routes[id])?.[1]??null:url.origin+url.pathname+url.search;
}
async function fingerprint(q) {
  const value=JSON.stringify([q.type,q.text,q.images.map(i=>[i.mime,i.dataUrl])]);
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function createController(api) {
  let providers=defaults(),run=null,tabMap={},calibrations={},promptContexts={},metadataQueue=Promise.resolve(),intent=0,answerPoll=null,polling=false,modelWindowId=null,windowOpening=null,refreshPending=null;
  const replyVersions=new WeakMap(),readSequences=new WeakMap();
  const ready=(async()=>{
    const [local,session]=await Promise.all([api.storage.local.get(['providers']),api.storage.session.get(['activeTask','run','tabMap','calibrations','modelWindowId','promptContexts'])]);
    if(local.providers) {try{providers=migrateProviders(local.providers,{addBuiltins:true});if(JSON.stringify(providers)!==JSON.stringify(local.providers))await api.storage.local.set({providers})}catch{ /* Keep valid defaults. */ }}
    tabMap=session.tabMap||{};calibrations=session.calibrations||{};modelWindowId=session.modelWindowId??null;promptContexts=session.promptContexts||{};
    const task=Object.hasOwn(session,'activeTask')?session.activeTask:session.run;
    if(task?.providers){
      const selected=migrateProviders(task.providers);
      run={id:task.id,questionType:task.questionType,startedAt:task.startedAt,questionHash:task.questionHash,providers:selected,cancelled:Boolean(task.cancelled),results:{}};
      for(const p of selected){
        const saved=task.results?.[p.id]||{},r=blank(p,task.id,saved.attempt||1);
        r.includesInstructions=saved.includesInstructions===true;
        if(Number.isInteger(saved.tabId))r.tabId=saved.tabId;
        if(saved.manualOverride||saved.source==='manual')Object.assign(r,{status:'error',error:'旧版人工答案不再使用，请重试本模型。'});
        else Object.assign(r,Number.isInteger(r.tabId)?{status:'sending'}:{status:'error',error:'上次发题流程已中断，请重试本模型。'});
        if(run.cancelled)Object.assign(r,{status:'error',error:'已停止本题'});
        run.results[p.id]=r;
      }
      if(!run.cancelled)await recoverSubmissions();
    }
    if(Object.hasOwn(session,'run')){
      await persistControl();
      await api.storage.session.remove('run');
    }
    syncPolling();
  })();
  async function recoverSubmissions(){
    await Promise.allSettled(run.providers.map(async p=>{
      const r=run.results[p.id];if(terminal(r))return;let timer;
      try{
        const tab=await api.tabs.get(r.tabId);
        if(!tab?.url||new URL(tab.url).origin!==new URL(p.url).origin||(tab.pendingUrl&&new URL(tab.pendingUrl).origin!==new URL(p.url).origin))throw Error('模型网页已失效');
        const reply=await Promise.race([api.tabs.sendMessage(r.tabId,{type:'site:status',providerId:p.id,runId:run.id,attempt:r.attempt}),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('发题状态读取超时')),3000)})]);
        if(!reply?.ok||typeof reply.submitted!=='boolean')throw Error('网页发题任务已失效');
        r.submitted=reply.submitted;
        if(r.submitted){recordInstructions(r,tab.url);await persistControl();}
        if(reply.status==='error')Object.assign(r,{status:'error',error:String(reply.error||'上次发题失败，请重试本模型。')});
        else if(reply.done&&r.submitted)applyReply(r,reply,true);
        else r.status=r.submitted?'generating':'sending';
      }catch(error){Object.assign(r,{status:'error',error:(error.message||'发题状态恢复失败')+'，请重试本模型。'})}
      finally{clearTimeout(timer)}
    }));
  }
  const state=()=>{
    const view=clone({providers,run,build:BUILD});
    if(view.run)view.run.phase=run.cancelled||!Object.values(run.results).some(needsPolling)?'finished':submissionsSettled(run)?'collecting':'sending';
    return view;
  };
  function taskMetadata() {
    if(!run)return null;
    return {id:run.id,questionType:run.questionType,startedAt:run.startedAt,questionHash:run.questionHash,providers:clone(run.providers),cancelled:Boolean(run.cancelled),
      results:Object.fromEntries(Object.entries(run.results).map(([id,r])=>[id,{providerId:r.providerId,runId:r.runId,attempt:r.attempt,tabId:r.tabId,includesInstructions:r.includesInstructions}]))};
  }
  function persistControl() {
    const snapshot={activeTask:taskMetadata(),tabMap:clone(tabMap),calibrations:clone(calibrations),modelWindowId,promptContexts:clone(promptContexts)};
    metadataQueue=metadataQueue.catch(()=>{}).then(()=>api.storage.session.set(snapshot));
    return metadataQueue;
  }
  async function publish() {
    syncPolling();
    try{await api.runtime.sendMessage({type:'hub:state',state:state()})}catch{ /* No dashboard open. */ }
  }
  function syncPolling() {
    const pending=submissionsSettled(run)&&Object.values(run.results).some(needsPolling);
    if(pending&&!answerPoll){
      answerPoll=setInterval(async()=>{
        if(polling)return;
        polling=true;
        try{await refresh()}finally{polling=false}
      },1500);
      answerPoll.unref?.();
    }else if(!pending&&answerPoll){clearInterval(answerPoll);answerPoll=null}
  }
  async function publishControl() {
    await Promise.all([publish(),persistControl()]);
  }
  function needsInstructions(p,tab){
    const saved=promptContexts[p.id],key=conversationKey(p.id,tab.url);
    if(saved?.tabId!==tab.id||!key||(saved.key!==null&&saved.key!==key))return true;
    saved.key=key;return false;
  }
  function recordInstructions(r,url){
    if(r.includesInstructions)promptContexts[r.providerId]={tabId:r.tabId,key:conversationKey(r.providerId,url)};
  }
  function applyReply(r,reply,fromRead=false) {
    if(r.source==='confirmed'||!needsPolling(r))return;
    if(r.submitted&&reply.status==='sending')return;
    if(!fromRead&&['generating','needs_confirmation','completed'].includes(reply.status))r.submitted=true;
    const incoming=String(reply.text||'').slice(0,60000);
    const statusOnly=!fromRead&&!incoming&&['sending','generating'].includes(reply.status);
    const text=statusOnly?r.text:incoming;
    const uncertain=isUncertainResponse(text),answer=reply.ambiguous?null:extractAnswer(text,run.questionType);
    const done=fromRead?reply.done===true&&!reply.stopped&&!reply.ambiguous:reply.status==='completed';
    let status,error=String(reply.error||'').slice(0,1000);
    if(reply.status==='error')status='error';
    else if(done)status=uncertain?'uncertain':answer?'completed':'needs_confirmation';
    else if(fromRead&&reply.status==='sending')status='sending';
    else if(fromRead)status=reply.stopped?'generating':reply.ambiguous||reply.status==='needs_confirmation'?'needs_confirmation':'generating';
    else status=reply.status;
    if(reply.ambiguous&&!error)error='本题回复匹配不明确，请打开模型网页核对。';
    Object.assign(r,{status,text,answer:status==='error'||uncertain?null:answer,error,replyFinished:done,readDelayed:false,updatedAt:Date.now()});
    replyVersions.set(r,(replyVersions.get(r)||0)+1);
  }
  function refresh() {
    if(!refreshPending)refreshPending=refreshAnswers().finally(()=>{refreshPending=null});
    return refreshPending;
  }
  async function refreshAnswers() {
    const task=run;if(!submissionsSettled(task))return;
    const readProvider=async p=>{
      const r=task.results[p.id];if(!submissionsSettled(task)||!r||!needsPolling(r)||r.source==='confirmed'||!Number.isInteger(r.tabId))return;
      const id=task.id,attempt=r.attempt,tabId=r.tabId,version=replyVersions.get(r)||0,sequence=(readSequences.get(r)||0)+1;
      readSequences.set(r,sequence);
      const valid=()=>run===task&&run.id===id&&submissionsSettled(task)&&run.results[p.id]===r&&needsPolling(r)&&r.attempt===attempt&&r.tabId===tabId&&r.source!=='confirmed'&&(replyVersions.get(r)||0)===version&&readSequences.get(r)===sequence;
      const official=tab=>tab.url&&new URL(tab.url).origin===new URL(p.url).origin&&(!tab.pendingUrl||new URL(tab.pendingUrl).origin===new URL(p.url).origin);
      let timer;
      try{
        const reading=(async()=>{
          const tab=await api.tabs.get(tabId);if(!valid())return;
          if(!official(tab))throw Error('模型页面已离开授权域名，请打开网页检查。');
          if(tab.windowId===modelWindowId){
            await api.tabs.update(tabId,{active:true});await sleep(120);if(!valid())return;
          }
          const reply=await api.tabs.sendMessage(tabId,{type:'site:read',providerId:p.id,runId:id,attempt});
          if(!valid())return;
          const latestTab=await api.tabs.get(tabId);if(!valid())return;
          if(!official(latestTab))throw Error('模型页面已离开授权域名，请打开网页检查。');
          if(!reply?.ok)throw Error(reply?.error||'未找到本题回复或页面任务已失效，请打开模型网页检查。');
          return reply;
        })();
        const timeout=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(Object.assign(Error('网页读取超时，正在自动重试。'),{readTimeout:true})),3000);
        });
        const reply=await Promise.race([reading,timeout]);
        if(!valid())return;
        applyReply(r,reply,true);
      }catch(error){
        if(valid()){
          Object.assign(r,{status:error.readTimeout?'generating':'needs_confirmation',text:'',answer:null,
            readDelayed:Boolean(error.readTimeout),error:'无法读取本题回复：'+(error.message||String(error)),updatedAt:Date.now()});
          replyVersions.set(r,version+1);
        }
      }finally{
        clearTimeout(timer);
      }
      // Publish each model as soon as it returns; another tab may be asleep or unresponsive.
      if(run===task&&!task.cancelled)await publish();
    };
    for(const p of task.providers)await readProvider(p);
  }
  const current=(id,attempt,pid)=>run?.id===id && run.results[pid]?.attempt===attempt && !run.cancelled && needsPolling(run.results[pid]);
  function provider(id){const p=providers.find(p=>p.id===id);if(!p)throw Error('找不到此模型');return p}
  async function permitted(p){if(!await api.permissions.contains({origins:[originPattern(p.url)]}))throw Error('请在模型设置中授权该 AI 网站，然后重试')}
  async function modelWindow(p){
    if(!windowOpening)windowOpening=(async()=>{
      if(modelWindowId!==null){try{return await api.windows.get(modelWindowId)}catch{modelWindowId=null}}
      const created=await api.windows.create({url:p.url,type:'normal',focused:false,width:1000,height:720});
      modelWindowId=created.id;
      if(created.tabs?.[0])tabMap[p.id]=created.tabs[0].id;
      return created;
    })().finally(()=>{windowOpening=null});
    return windowOpening;
  }
  async function dedicated(p,active=false,valid=()=>true){
    await permitted(p);
    let tab;try{if(tabMap[p.id])tab=await api.tabs.get(tabMap[p.id])}catch{}
    // A user may have navigated our tab elsewhere. Never replace that page.
    if(tab && (!tab.url || new URL(tab.url).origin!==new URL(p.url).origin || (tab.pendingUrl && new URL(tab.pendingUrl).origin!==new URL(p.url).origin))){delete tabMap[p.id];tab=null;}
    if(!valid())throw Error('本次操作已取消');
    const window=await modelWindow(p);if(!valid())throw Error('本次操作已取消');
    if(!tab){
      if(tabMap[p.id]){try{tab=await api.tabs.get(tabMap[p.id])}catch{}}
      if(!tab)tab=await api.tabs.create({url:p.url,active:false,windowId:window.id});
    }
    if(tab.windowId!==window.id)tab=await api.tabs.move(tab.id,{windowId:window.id,index:-1});
    if(active){await api.tabs.update(tab.id,{active:true});await api.windows.update(window.id,{focused:true})}
    await api.tabs.update(tab.id,{autoDiscardable:false});
    tabMap[p.id]=tab.id;return tab;
  }
  async function inject(p,tabId,valid=()=>true){
    const end=Date.now()+30000;
    let reloaded=false;
    while(Date.now()<end){
      if(!valid())throw Error('该次发送已取消');
      const tab=await api.tabs.get(tabId);
      if(tab.url && new URL(tab.url).origin!==new URL(p.url).origin)throw Error('AI 页面跳转到了其他域名，请检查登录状态');
      if(tab.status==='complete'){
        await api.scripting.executeScript({target:{tabId},files:['page-bridge.js'],world:'MAIN'});
        await api.scripting.executeScript({target:{tabId},files:['content.js']});
        if(!valid())throw Error('该次发送已取消');
        const ack=await api.tabs.sendMessage(tabId,{type:'site:ping'});
        if(ack?.ok){
          if(ack.build===BUILD&&ack.contentRevision===CONTENT_REVISION)return;
          if(reloaded)throw Error('模型网页适配更新未生效，请重试本模型');
          if(!await resetDraft(p,tabId,valid))return;
          reloaded=true;await sleep(250);continue;
        }
      }
      await sleep(250);
    }
    throw Error('AI 页面加载超时，请打开网页检查网络或登录状态');
  }
  async function dispatch(p,q,id,attempt){
    const valid=()=>current(id,attempt,p.id);
    try{
      if(!valid())return;
      const tab=await dedicated(p,false,valid);
      if(!valid())return;
      run.results[p.id].tabId=tab.id;await publishControl();
      await inject(p,tab.id,valid);
      if(!valid())return;
      const latestTab=await api.tabs.get(tab.id);if(!valid())return;
      const includesInstructions=needsInstructions(p,latestTab);
      Object.assign(run.results[p.id],{status:'sending',includesInstructions,updatedAt:Date.now()});await publishControl();
      if(!valid())return;
      const message={type:'site:start',build:BUILD,contentRevision:CONTENT_REVISION,provider:clone(p),question:q,prompt:buildPrompt(q,{includeInstructions:includesInstructions}),runId:id,attempt};
      let ack=await api.tabs.sendMessage(tab.id,message);
      if(ack?.resetRequired){
        if(!await resetDraft(p,tab.id,valid))return;
        await inject(p,tab.id,valid);if(!valid())return;
        ack=await api.tabs.sendMessage(tab.id,message);
      }
      if(!ack?.ok)throw Error(ack?.error||'页面未接受发送请求');
    }catch(e){if(valid()){Object.assign(run.results[p.id],{status:'error',error:e.message,updatedAt:Date.now()});await publish()}}
  }
  async function resetDraft(p,tabId,valid=()=>true){
    if(!valid())return false;
    const tab=await api.tabs.get(tabId);if(!valid())return false;
    if(!tab.url||new URL(tab.url).origin!==new URL(p.url).origin||(tab.pendingUrl&&new URL(tab.pendingUrl).origin!==new URL(p.url).origin))throw Error('模型页面已离开授权域名，未重置其他网页。');
    await api.tabs.reload(tabId);return true;
  }
  async function cancelSites(targetRun=run,valid=()=>true){
    const results=Object.values(targetRun?.results||{}).filter(r=>Number.isInteger(r.tabId));
    await Promise.allSettled(results.map(async r=>{
      if(!valid())return;
      const ack=await api.tabs.sendMessage(r.tabId,{type:'site:cancel',runId:r.runId,attempt:r.attempt,stopGeneration:true});
      const p=targetRun.providers.find(p=>p.id===r.providerId);
      if(ack?.resetRequired&&p&&valid())await resetDraft(p,r.tabId,valid);
    }));
  }
  function blank(p,id,attempt=1){return {providerId:p.id,runId:id,attempt,status:'opening',submitted:false,includesInstructions:false,replyFinished:false,text:'',answer:null,error:'',source:'auto',updatedAt:Date.now()}}
  function siteResult(m,sender){
    const r=run?.results[m.providerId],p=run?.providers.find(p=>p.id===m.providerId);
    if(!r||!p||run.cancelled||m.runId!==run.id||m.attempt!==r.attempt||sender.tab?.id!==r.tabId||sender.frameId>0)throw Error('已忽略不匹配的页面消息');
    if(new URL(sender.url||'https://invalid.test').origin!==new URL(p.url).origin)throw Error('消息来源域名不匹配');
    return r;
  }
  async function handle(m={},sender={}){
    try{
      await ready;
      if(m.type==='site:update'){
        const r=siteResult(m,sender);
        if(r.source!=='confirmed'){
          if(!['sending','generating','needs_confirmation','completed','error'].includes(m.status))throw Error('无效页面状态');
          const wasSubmitted=r.submitted;applyReply(r,m);
          if(!wasSubmitted&&r.submitted){recordInstructions(r,sender.url);await persistControl();}
          await publish();
        }
        return {ok:true};
      }
      if(m.type==='site:calibrated'){
        const c=calibrations[m.token],p=provider(m.providerId);
        if(!c||c.providerId!==p.id||c.field!==m.field||c.tabId!==sender.tab?.id||sender.frameId>0||Date.now()>c.expires||new URL(sender.url||'https://invalid.test').origin!==new URL(p.url).origin)throw Error('校准消息不匹配');
        if(typeof m.selector!=='string'||!m.selector||m.selector.length>1500)throw Error('校准选择器无效');
        p.selectors[m.field]=m.selector;delete calibrations[m.token];await api.storage.local.set({providers});await publishControl();return {ok:true};
      }
      if(sender.url!==api.runtime.getURL('dashboard.html'))throw Error('仅允许从并答面板发起操作');
      if(m.type==='hub:get'||m.type==='hub:refresh'){await refresh();return {ok:true,state:state()};}
      if(m.type==='hub:saveProviders'){
        const ps=sanitizeProviders(m.providers);await Promise.all(ps.filter(p=>p.enabled).map(permitted));providers=ps;await api.storage.local.set({providers});await publish();
      }else if(m.type==='hub:open'){
        await dedicated(provider(m.providerId),true);await publishControl();
      }else if(m.type==='hub:start'){
        if(m.manualOnly)throw Error('此版本不支持人工汇总，请使用一键发送');
        const errors=validateQuestion(m.question);if(errors.length)throw Error(errors.join('；'));
        const selected=providers.filter(p=>p.enabled&&(!m.providerIds||m.providerIds.includes(p.id)));
        if(!selected.length)throw Error('至少启用一个模型');
        const ticket=++intent,hash=await fingerprint(m.question);if(ticket!==intent)throw Error('此请求已被后续操作替代');
        if(run)run.cancelled=true;
        await cancelSites(run,()=>ticket===intent);if(ticket!==intent)throw Error('此请求已取消');
        const id=crypto.randomUUID();run={id,questionType:m.question.type,startedAt:Date.now(),questionHash:hash,providers:clone(selected),results:Object.fromEntries(selected.map(p=>[p.id,blank(p,id)]))};
        await publishControl();
        await Promise.allSettled(selected.map(p=>dispatch(p,m.question,id,1)));
      }else if(m.type==='hub:retry'){
        if(!run||run.cancelled)throw Error('请先开始一题');
        const errors=validateQuestion(m.question);if(errors.length)throw Error(errors.join('；'));
        const id=run.id,hash=await fingerprint(m.question);
        if(run?.id!==id||run.cancelled||hash!==run.questionHash)throw Error('重试必须使用本题发送时的原文字和原图片');
        const p=run.providers.find(p=>p.id===m.providerId),old=run.results[m.providerId];if(!p||!old)throw Error('本题未包含此模型');
        const updated=providers.find(provider=>provider.id===p.id);
        if(updated){p.selectors=clone(updated.selectors);p.sendEvent=updated.sendEvent;}
        const attempt=old.attempt+1;run.results[p.id]=blank(p,id,attempt);await publishControl();
        await cancelSites({providers:[p],results:{[p.id]:old}},()=>current(id,attempt,p.id));
        await dispatch(p,m.question,id,attempt);
      }else if(m.type==='hub:confirm'){
        const r=run?.results[m.providerId];if(!r)throw Error('请先开始一题');
        if(r.status==='uncertain'||isUncertainResponse(r.text))throw Error('模型已明确无法确认，请重试本模型');
        const answer=extractAnswer(r.text,run.questionType);
        if(!answer)throw Error('未找到明确答案，请重试本模型');
        if(r.status!=='needs_confirmation')throw Error('请等待回复结束后再确认');
        Object.assign(r,{status:'completed',answer,error:'',readDelayed:false,source:'confirmed',updatedAt:Date.now()});await publishControl();
      }else if(m.type==='hub:cancel'||m.type==='hub:clear'){
        const ticket=++intent,oldRun=run;if(oldRun){oldRun.cancelled=true;for(const r of Object.values(oldRun.results))if(!terminal(r))Object.assign(r,{status:'error',error:'已停止本题',answer:null})}
        if(m.type==='hub:clear')run=null;await publishControl();await cancelSites(oldRun,()=>ticket===intent);
      }else if(m.type==='hub:calibrate'){
        if(!SELECTOR_FIELDS.includes(m.field))throw Error('校准字段无效');
        const p=provider(m.providerId),tab=await dedicated(p,true);await inject(p,tab.id);
        const token=crypto.randomUUID();calibrations[token]={providerId:p.id,field:m.field,tabId:tab.id,expires:Date.now()+120000};
        await publishControl();await api.tabs.sendMessage(tab.id,{type:'site:calibrate',providerId:p.id,field:m.field,token});
      }else throw Error('未知操作');
      return {ok:true,state:state()};
    }catch(e){return {ok:false,error:e.message||String(e)}}
  }
  return {handle};
}

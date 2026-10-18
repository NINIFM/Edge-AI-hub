(() => {
  const mark = () => document.documentElement?.setAttribute('data-bingda-page-bridge','17');
  if (document.documentElement) mark(); else document.addEventListener('DOMContentLoaded',mark,{once:true});
  if (window.__bingdaPageBridgeInstalled) return;
  window.__bingdaPageBridgeInstalled = true;
  const active = () => Boolean(document.documentElement?.getAttribute('data-bingda-active'));
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const NativeFile = File, NativeTransfer = DataTransfer, NativePaste = ClipboardEvent;
  const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
  const frames = new Map();
  for (const [name, value] of [['hidden', false], ['visibilityState', 'visible']]) {
    const descriptor = Object.getOwnPropertyDescriptor(document, name) || Object.getOwnPropertyDescriptor(Document.prototype, name);
    if (descriptor?.get) Object.defineProperty(document, name, {configurable:true, get:() => active() ? value : descriptor.get.call(document)});
  }
  window.requestAnimationFrame = callback => {
    const id = nativeFrame(time => {
      if (!frames.has(id)) return;
      frames.delete(id); callback(time);
    });
    frames.set(id, callback); return id;
  };
  window.cancelAnimationFrame = id => { frames.delete(id); nativeCancel(id); };
  let flushing = false, pulseBlocked = false;
  const pulse = () => {
    if (!active() || flushing || pulseBlocked || !frames.size) return;
    // DOM observers run before the next task. Let messages/timers run before forcing another frame.
    pulseBlocked = true;
    setTimeout(() => { pulseBlocked = false; },0);
    flushing = true;
    try {
      for (const [id, callback] of [...frames]) {
        if (!frames.delete(id)) continue;
        nativeCancel(id);
        try { callback(performance.now()); } catch (error) { console.error(error); }
      }
    } finally { flushing = false; }
  };
  document.addEventListener('bingda:tick', pulse);
  document.addEventListener('bingda:action', event => {
    let target, request;
    try {
      request = JSON.parse(event.detail);
      target = document.querySelector(`[data-bingda-action-id="${CSS.escape(request.id)}"]`);
      if (!active() || !target) throw Error('网页操作上下文已失效。');
      if (request.action === 'fill' && target instanceof HTMLTextAreaElement) {
        textSetter.call(target,request.text);
        target.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:request.text}));
        target.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      } else if (request.action === 'click' && target instanceof HTMLElement) target.click();
      else throw Error('网页操作类型无效。');
      target.setAttribute('data-bingda-action-result',JSON.stringify({id:request.id,ok:true}));
    } catch (error) {
      if (target) target.setAttribute('data-bingda-action-result',JSON.stringify({id:request.id,ok:false,error:error.message}));
    }
  });
  let wasActive = active();
  new MutationObserver(() => {
    const now = active();
    if (now === wasActive) return;
    wasActive = now;
    document.dispatchEvent(new Event('visibilitychange'));
    if (now) pulse();
  }).observe(document, {subtree:true, attributes:true, attributeFilter:['data-bingda-active']});
  // Construct clipboard files in the website's own realm, so native File/DataTransfer checks pass.
  document.addEventListener('bingda:paste-images', event => {
    let input, request;
    try {
      request = JSON.parse(event.detail);
      input = document.querySelector(`[data-bingda-upload-id="${CSS.escape(request.id)}"]`);
      if (!active() || !input || !Array.isArray(request.images) || request.images.length < 1 || request.images.length > 4) throw Error('图片上传上下文已失效。');
      const transfer = new NativeTransfer();
      for (const image of request.images) {
        if (!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mime) || !image.dataUrl?.startsWith(`data:${image.mime};base64,`)) throw Error('原图格式无效。');
        const bytes = Uint8Array.from(atob(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)), c => c.charCodeAt(0));
        if (bytes.length !== image.size || bytes.length < 1 || bytes.length > 8 * 1024 * 1024) throw Error('原图数据不完整。');
        transfer.items.add(new NativeFile([bytes], image.name, {type:image.mime}));
      }
      input.dispatchEvent(new NativePaste('paste', {clipboardData:transfer, bubbles:true, cancelable:true}));
      input.setAttribute('data-bingda-upload-result', JSON.stringify({id:request.id,ok:true}));
    } catch (error) {
      if (input) input.setAttribute('data-bingda-upload-result', JSON.stringify({id:request.id,ok:false,error:error.message}));
    }
  });
})();

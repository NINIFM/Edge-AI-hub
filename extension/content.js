(() => {
  if (globalThis.__edgeAnswerHubContentInstalled) return;
  globalThis.__edgeAnswerHubContentInstalled = true;
  const BUILD = '2.0';
  const CONTENT_REVISION = 18;
  let active = null;
  // Keep the website task until its stop action has been acknowledged.
  let pageGeneration = null;
  let pagePendingPaste = null;
  let clearCalibration = null;
  const allowedFields = new Set(['input', 'send', 'response', 'responseRoot', 'stop', 'done', 'attachment']);
  const current = task => active === task && !task.abort.signal.aborted;
  const pageToken = task => `${task.runId}:${task.attempt}`;
  const pulsePage = () => document.dispatchEvent(new Event('bingda:tick'));
  let actionSequence = 0;
  function pageAction(target,action,payload={}) {
    const id = `bingda-${++actionSequence}`;
    target.setAttribute('data-bingda-action-id',id);target.removeAttribute('data-bingda-action-result');
    document.dispatchEvent(new CustomEvent('bingda:action',{detail:JSON.stringify({id,action,...payload})}));
    const result = JSON.parse(target.getAttribute('data-bingda-action-result') || 'null');
    target.removeAttribute('data-bingda-action-id');target.removeAttribute('data-bingda-action-result');
    if(!result?.ok || result.id!==id)throw Error(result?.error || '网页提交适配未加载，请重试本模型。');
  }
  function releasePage(task) {
    if (document.documentElement.getAttribute('data-bingda-active') === pageToken(task)) document.documentElement.removeAttribute('data-bingda-active');
  }
  const send = message => { try { Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {}); } catch {} };
  function update(task, status, text = task.text || '', error = '') {
    if (!current(task)) return;
    task.text = text; task.status = status; task.error = error;
    // Keep streaming text on the page; only publish it when collection needs a result or confirmation.
    const reportedText = ['sending', 'generating'].includes(status) ? '' : text;
    const key = JSON.stringify([status, reportedText, error]);
    if (task.last === key) return;
    task.last = key;
    send({ type: 'site:update', providerId: task.provider.id, runId: task.runId, attempt: task.attempt, status, text: reportedText, error });
  }
  function visible(element) {
    if (!element?.isConnected) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  const ready = element => visible(element) && !element.disabled && !element.closest('[disabled], [aria-disabled="true"], .ds-button--disabled');
  function findAll(selector, root = document) {
    if (!selector) return [];
    try { return [...root.querySelectorAll(selector)]; } catch { throw Error('页面选择器无效，请重新校准控件。'); }
  }
  const find = selector => findAll(selector).find(visible);
  async function revealLatestReply(task) {
    if(task.provider.id!=='deepseek')return;
    // DeepSeek virtualizes the chat list. Scrolling also mounts answers below expanded thinking.
    for(let pass=0;pass<2&&current(task);pass++){
      const list=find('.ds-virtual-list.ds-scroll-area');
      if(!list||list.scrollHeight-list.clientHeight-list.scrollTop<=2)return;
      list.scrollTo({top:list.scrollHeight,behavior:'instant'});
      await new Promise(resolve=>setTimeout(resolve,60));
      if(current(task))pulsePage();
    }
  }
  function cancel() {
    if (active) active.abort.abort();
    active = null;
  }
  function waitFor(task, predicate, timeout, message) {
    return new Promise((resolve, reject) => {
      let observer, timer, poll;
      const cleanup = () => { observer?.disconnect(); clearTimeout(timer); clearInterval(poll); task?.abort.signal.removeEventListener('abort', aborted); };
      const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
      const aborted = () => finish(Error('任务已取消。'));
      const check = () => {
        if (task && !current(task)) return aborted();
        try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); }
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => finish(Error(message)), timeout);
      poll = setInterval(() => { pulsePage(); check(); }, 300);
      task?.abort.signal.addEventListener('abort', aborted, { once: true });
      pulsePage(); check();
    });
  }
  function normalizedParagraphText(value) {
    return value.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
  }
  function editableText(input) {
    const read = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-slate-placeholder') || node.hasAttribute('data-slate-zero-width') || !visible(node)) return '';
      if (node.localName === 'br') return '\n';
      const text = [...node.childNodes].map(read).join('');
      const block = /^(?:p|div|li|section|article|blockquote|pre|h[1-6])$/.test(node.localName) && node.getAttribute('data-slate-inline') !== 'true';
      return text + (block ? '\n' : '');
    };
    return normalizedParagraphText(read(input));
  }
  async function fillInput(task, input, prompt) {
    input.focus();
    if (task.provider.id === 'step') {
      pageAction(input,'fill',{text:prompt});
      await waitFor(task,()=>input.isConnected&&input.value===prompt,5000,'阶跃网页未接受题目文字。');
      return;
    }
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, prompt);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (input.value !== prompt) throw Error('题目文字未能完整写入输入框。');
    } else if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      const range = document.createRange(); range.selectNodeContents(input);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      // Slate must process selection before its paste handler updates the editor model.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current(task)) return;
      const transfer = new DataTransfer(); transfer.setData('text/plain', prompt);
      let paste;
      try { paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }); } catch { throw Error('当前浏览器无法构造题目文字粘贴事件。'); }
      if (paste.clipboardData?.getData('text/plain') !== prompt) throw Error('题目文字粘贴数据不完整，已停止发送。');
      input.dispatchEvent(paste);
      await waitFor(task, () => input.isConnected && !findAll('[data-slate-placeholder]', input).some(visible) && editableText(input) === normalizedParagraphText(prompt), 5000,
        '富文本输入框未同步完整题目文字，已停止发送；请查看原页面或手动粘贴。');
    } else throw Error('选择的控件不是可编辑输入框。');
  }
  async function uploadImages(task, images, selectors, input) {
    if (!images.length) return;
    if (!selectors.attachment) throw Error('未配置可验证的图片附件控件，无法确认原图上传。');
    if (findAll(selectors.attachment).filter(visible).length) throw Error('输入区已有附件，请先移除旧图片。');
    const transfer = new DataTransfer();
    for (const image of images) {
      if (!current(task)) return;
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime) || typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(`data:${image.mime};base64,`)) throw Error('原图格式无效。');
      let binary;
      try { binary = atob(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)); } catch { throw Error('原图数据损坏。'); }
      if (!Number.isSafeInteger(image.size) || binary.length !== image.size || !image.size || image.size > 8 * 1024 * 1024) throw Error('原图数据与图片大小不一致。');
      transfer.items.add(new File([Uint8Array.from(binary, character => character.charCodeAt(0))], image.name, { type: image.mime }));
    }
    if (!current(task)) return;
    let paste;
    try {
      paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
      if (paste.clipboardData?.files.length !== images.length) paste = null;
    } catch { paste = null; }
    if (!paste) throw Error('当前浏览器无法可靠构造原图粘贴事件，请在模型页面手动粘贴原图。');
    pagePendingPaste = task;
    input.focus();
    if (['hunyuan','step'].includes(task.provider.id)) {
      const id = pageToken(task);
      input.setAttribute('data-bingda-upload-id', id);
      input.removeAttribute('data-bingda-upload-result');
      document.dispatchEvent(new CustomEvent('bingda:paste-images', {detail:JSON.stringify({id,images})}));
      const result = JSON.parse(input.getAttribute('data-bingda-upload-result') || 'null');
      input.removeAttribute('data-bingda-upload-id'); input.removeAttribute('data-bingda-upload-result');
      if (!result?.ok || result.id !== id) throw Error(result?.error || `图片上传适配未加载，请刷新${task.provider.name}网页后重试。`);
    } else input.dispatchEvent(paste);
    const uploadingVisible = element => {
      if (!visible(element)) return false;
      // DeepSeek retains the finished upload spinner inside a transparent overlay.
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        if (getComputedStyle(node).opacity === '0') return false;
      }
      return true;
    };
    // Paste failure is reported directly; no second image dispatch can duplicate attachments.
    await waitFor(task, () => {
      const attachments = findAll(selectors.attachment).filter(visible);
      const uploading = '[aria-busy="true"], [role="progressbar"], progress, [data-state="uploading"], [data-uploading="true"], .uploading, .is-uploading, .loading, .ds-loading, .animate-spin';
      const attachmentReady = element => {
        if ((element.matches(uploading) && uploadingVisible(element)) || findAll(uploading, element).some(uploadingVisible)) return false;
        const previews = element instanceof HTMLImageElement ? [element] : findAll('img', element);
        return previews.length > 0 && previews.every(image => {
          const source = image.currentSrc || image.src;
          const localPreview = ['deepseek','step'].includes(task.provider.id) && source.startsWith(`blob:${location.origin}/`);
          return image.complete && image.naturalWidth > 0 && (/^https:\/\//i.test(source) || localPreview);
        });
      };
      return attachments.length === images.length && attachments.every(attachmentReady) && ready(find(selectors.send));
    }, 20000, '无法确认全部图片已上传完成，已阻止发送残缺题目。');
    task.uploadReady = true;
  }
  function turnKey(root, providerId) {
    if (!root) return null;
    const attributes = ['data-virtual-list-item-key', 'data-message-id', 'data-answer-id', 'data-turn-id', 'id'];
    if (providerId === 'step') attributes.unshift('data-id');
    if (providerId === 'qwen') attributes.unshift('data-chat-answers-wrap');
    if (providerId === 'hunyuan') attributes.unshift('data-trace-id');
    for (const attribute of attributes) {
      const value = root.getAttribute(attribute);
      if (value) return `${attribute}:${value}`;
    }
    if (providerId === 'glm') {
      // GLM keeps the message id on its interaction toolbar, not on .answer-content.
      const markers = findAll('.interact-container[id^="interactContainer-"]', root);
      if (markers.length === 1) return `glm:${markers[0].getAttribute('id')}`;
    }
    return null;
  }
  function responseEvidence(task) {
    const selectors = task.provider.selectors;
    const snapshot = task.snapshot;
    if (!snapshot) return null;
    const qwen = task.provider.id === 'qwen';
    const finalElement = element => !(task.provider.id==='hunyuan'&&element.closest('.hyc-component-deepsearch-cot__think'))
      && !(task.provider.id==='deepseek'&&element.closest('.ds-think-content'));
    const candidates = findAll(selectors.response).filter(finalElement);
    const rootTexts = new Map();
    const textOf = element => (element.innerText ?? element.textContent).trim();
    const rootText = root => {
      if (!rootTexts.has(root)) rootTexts.set(root, candidates.filter(element => root.contains(element) && visible(element)).map(textOf).join('\n'));
      return rootTexts.get(root);
    };
    let replies = candidates.filter(element => {
      if ((!qwen && snapshot.replies.has(element)) || !visible(element) || element === document.body || element === document.documentElement || !textOf(element)) return false;
      const root = selectors.responseRoot ? element.closest(selectors.responseRoot) : null;
      const key = turnKey(root, task.provider.id);
      if (qwen && key) {
        if (snapshot.keys.has(key)) return false;
        // A new turn key alone does not prove that a recycled DOM node has new answer text.
        if (snapshot.replies.has(element) && (!snapshot.replyTexts?.has(element) || snapshot.replyTexts.get(element) === textOf(element))) return false;
        if (snapshot.roots.has(root) && (!snapshot.rootTexts?.has(root) || snapshot.rootTexts.get(root) === rootText(root))) return false;
        if (snapshot.roots.has(root) && snapshot.rootReplyTexts?.get(root)?.has(textOf(element))) return false;
        return true;
      }
      return !snapshot.replies.has(element) && !snapshot.roots.has(root) && !(key && snapshot.keys.has(key));
    });
    const stopped = selectors.stop && findAll(selectors.stop).some(visible);
    const uncertain = () => ({ text: '', done: false, stopped: Boolean(stopped), ambiguous: true, safeRoot: null });
    const binding = task.responseBinding;
    if (binding) {
      const newReplies = replies.length;
      replies = replies.filter(element => {
        const root = selectors.responseRoot ? element.closest(selectors.responseRoot) : null;
        if (binding.key) return turnKey(root, task.provider.id) === binding.key;
        return binding.root ? root === binding.root : element === binding.reply;
      });
      if (!replies.length && (newReplies || (binding.root && !binding.root.isConnected) || (!binding.root && !binding.reply.isConnected))) return uncertain();
    } else {
      const turns = new Set(replies.map(element => {
        const root = selectors.responseRoot ? element.closest(selectors.responseRoot) : null;
        return turnKey(root, task.provider.id) || root || element;
      }));
      if (turns.size > 1) return uncertain();
    }
    const latest = replies.at(-1);
    if (!latest) return null;
    const root = selectors.responseRoot ? latest.closest(selectors.responseRoot) : null;
    const safeRoot = root && root !== document.body && root !== document.documentElement ? root : null;
    // Before binding a reply, an unkeyed historical root disappearing makes its provenance unknowable.
    const ambiguous = !binding && [...snapshot.unkeyedRoots].some(previous => !previous.isConnected);
    if (!binding && !ambiguous) task.responseBinding = { key: turnKey(safeRoot, task.provider.id), root: safeRoot, reply: latest };
    const inRoot = safeRoot ? replies.filter(element => safeRoot.contains(element)) : [latest];
    const text = inRoot.map(element => (element.innerText ?? element.textContent).trim()).join('\n');
    const keyedQwen = qwen && turnKey(safeRoot, task.provider.id) && !snapshot.keys.has(turnKey(safeRoot, task.provider.id));
    const done = safeRoot && selectors.done && findAll(selectors.done, safeRoot).some(element => {
      const reusedCurrentReply = keyedQwen && inRoot.some(reply => reply === element || reply.contains(element));
      return (!snapshot.done.has(element) || reusedCurrentReply) && visible(element) && finalElement(element);
    });
    return { text, done, stopped, ambiguous, safeRoot };
  }
  function readReply(task) {
    if(!current(task))throw Error('本题采集上下文已失效，请重新发送本题后再读取。');
    if(task.pageFinished)return {ok:true,text:task.text,done:true,stopped:false,ambiguous:false,status:'completed'};
    pulsePage();
    const evidence=responseEvidence(task);
    const unavailable=!evidence&&task.responseBinding&&task.status==='needs_confirmation';
    const ambiguous=Boolean(evidence?.ambiguous||unavailable);
    const stopped=evidence?evidence.stopped:task.provider.selectors.stop&&findAll(task.provider.selectors.stop).some(visible);
    if(evidence&&!ambiguous)task.text=evidence.text;
    if(evidence?.done&&!stopped&&!ambiguous){finishGeneration(task);task.status='completed';}
    return {ok:true,text:evidence&&!ambiguous?evidence.text:'',done:Boolean(evidence?.done)&&!ambiguous,
      stopped:Boolean(stopped),ambiguous,status:ambiguous?'needs_confirmation':task.status||'generating',
      error:unavailable?'本题回复节点已无法可靠定位，请查看原网页确认。':''};
  }
  function generationFinished(task) {
    if (task.pageFinished) return true;
    const evidence = responseEvidence(task);
    return Boolean(evidence?.done && !evidence.stopped && !evidence.ambiguous);
  }
  function retainedPrompt(task) {
    if (!task?.sent || !task.prompt || responseEvidence(task)) return false;
    const selectors = task.provider.selectors;
    if (selectors.stop && findAll(selectors.stop).some(visible)) return false;
    const input = find(selectors.input);
    const text = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input && editableText(input);
    return ready(input) && normalizedParagraphText(text) === normalizedParagraphText(task.prompt);
  }
  function hasPendingPaste() {
    // A settled upload whose thumbnails have left the composer no longer owns a draft.
    if (pagePendingPaste?.uploadReady && !findAll(pagePendingPaste.provider.selectors.attachment).some(visible)) pagePendingPaste = null;
    return Boolean(pagePendingPaste);
  }
  function canStartGeneration(provider, previous) {
    if (provider.selectors?.stop && findAll(provider.selectors.stop).some(visible)) return false;
    if (!previous) return true;
    if (retainedPrompt(previous)) return true;
    // GLM hides/remounts older answer controls; use its current idle composer to release old capture state.
    if (provider.id === 'glm' && ready(find(provider.selectors?.input)) && findAll('.enter:not(.searching)').some(visible)) return true;
    if (provider.id === 'step' && ready(find(provider.selectors?.input)) && findAll('button:has(.custom-icon-send-outline)').some(visible)) return true;
    return generationFinished(previous);
  }
  function pressControl(provider, button) {
    if (provider.id === 'step') pageAction(button,'click');
    else if (provider.sendEvent === 'mousedown') button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
    else button.click();
  }
  async function interruptGeneration(task, provider, previous = pageGeneration) {
    let requested = Boolean(previous?.stopRequested);
    await waitFor(task, () => {
      const stop = find(provider.selectors?.stop);
      if (stop) {
        if (!requested) {
          requested = true;
          if (previous) previous.stopRequested = true;
          // GLM handles mousedown on the inner icon, not on its outer .enter wrapper.
          const button = provider.id === 'glm' ? findAll('.enter_icon', stop).find(visible) || stop : stop;
          pressControl(provider, button);
        }
        return false;
      }
      return requested || canStartGeneration(provider, previous);
    }, 10000, '网页尚未确认停止上一题，未发送新题；请打开原网页检查停止按钮后重试。');
    if (previous) previous.pageFinished = true;
    if (pageGeneration === previous) pageGeneration = null;
  }
  function finishGeneration(task) {
    task.pageFinished = true;
    releasePage(task);
    if (pageGeneration === task) pageGeneration = null;
  }
  async function execute(task, message) {
    try {
      update(task, 'sending');
      if (new URL(task.provider.url).origin !== location.origin || location.protocol !== 'https:') throw Error('当前页面与模型官方域名不匹配。');
      const selectors = task.provider.selectors;
      if (!selectors?.input || !selectors.send || !selectors.response) throw Error('请先配置输入、发送和模型回复控件。');
      for (const field of Object.keys(selectors)) if (selectors[field]) findAll(selectors[field]);
      if (/^(?:body|html|\*)$/i.test(selectors.response.trim()) || findAll(selectors.response).some(element => element === document.body || element === document.documentElement)) throw Error('回复控件不能选择整页正文，请重新校准。');
      if (typeof message.prompt !== 'string' || (!message.prompt.trim()&&!message.question?.images?.length)) throw Error('题目文字与图片均为空。');
      task.prompt = message.prompt;
      const images = message.question?.images;
      if (!Array.isArray(images) || images.length > 4 || images.reduce((total, image) => total + (image?.size || 0), 0) > 20 * 1024 * 1024) throw Error('图片数量或总大小无效。');
      // A new question supersedes the old one. Stop it before touching the composer or images.
      await revealLatestReply(task);
      if(!current(task))return;
      await interruptGeneration(task, task.provider, task.previousGeneration);
      if (!current(task)) return;
      if (pageGeneration === task.previousGeneration) pageGeneration = null;
      task.previousGeneration = null;
      const input = await waitFor(task, () => { const element = find(selectors.input); return ready(element) && element; }, 5000, '找不到可用的题目输入框，请确认登录或校准页面。');
      if (!current(task)) return;
      if (selectors.attachment && findAll(selectors.attachment).some(visible)) throw Error('输入区仍有旧图片或旧附件，请先在原页面移除，避免混入下一题。');
      if(message.prompt)await fillInput(task, input, message.prompt);
      else if((input instanceof HTMLTextAreaElement||input instanceof HTMLInputElement?input.value:editableText(input)).trim())throw Error('输入区仍有未发送文字，请先清空后重试图片题。');
      await uploadImages(task, images, selectors, input);
      const button = await waitFor(task, () => { const element = find(selectors.send); return ready(element) && element; }, 5000, '发送按钮不可用，请确认登录、模式或附件状态。');
      if (!current(task)) return;
      if (selectors.stop && findAll(selectors.stop).some(visible)) throw Error('请等待原网页上一题生成结束后再发送，当前页面正在生成。');
      if (!images.length && selectors.attachment && findAll(selectors.attachment).some(visible)) throw Error('输入区出现旧图片或旧附件，已阻止混入下一题，请在原页面清除。');
      await revealLatestReply(task);
      if(!current(task))return;
      const baselineReplies = new Set(findAll(selectors.response));
      const baselineRoots = new Set(selectors.responseRoot ? [...baselineReplies].map(element => element.closest(selectors.responseRoot)).filter(root => root && root !== document.body && root !== document.documentElement) : []);
      task.snapshot = { replies: baselineReplies, done: new Set(findAll(selectors.done)), roots: baselineRoots,
        keys: new Set([...baselineRoots].map(root => turnKey(root, task.provider.id)).filter(Boolean)),
        unkeyedRoots: new Set([...baselineRoots].filter(root => !turnKey(root, task.provider.id))) };
      if (task.provider.id === 'qwen') {
        const textOf = element => (element.innerText ?? element.textContent).trim();
        task.snapshot.replyTexts = new Map([...baselineReplies].map(element => [element, textOf(element)]));
        task.snapshot.rootTexts = new Map([...baselineRoots].map(root => [root, [...baselineReplies].filter(element => root.contains(element)).map(textOf).join('\n')]));
        task.snapshot.rootReplyTexts = new Map([...baselineRoots].map(root => [root, new Set([...baselineReplies].filter(element => root.contains(element)).map(textOf))]));
      }
      const sendEvent = task.provider.sendEvent === 'mousedown' ? 'mousedown' : 'click';
      const diagnostic = { build: BUILD, contentRevision: CONTENT_REVISION, providerId: task.provider.id, runId: task.runId,
        sendSelector: selectors.send, targetTag: button.tagName, targetClass: button.getAttribute('class') || '', sendEvent };
      console.info('[并答诊断]', JSON.stringify({ ...diagnostic, phase: 'before-send' }));
      task.sent = true; pageGeneration = task;
      pressControl(task.provider, button);
      await waitFor(task,()=>{
        const composer=find(selectors.input);
        const text=composer instanceof HTMLTextAreaElement||composer instanceof HTMLInputElement?composer.value:composer&&editableText(composer);
        const evidence=responseEvidence(task);
        const cleared=composer&&text.trim()===''&&(!images.length||!findAll(selectors.attachment).some(visible));
        return cleared || findAll(selectors.stop).some(visible) || (evidence&&!evidence.ambiguous);
      },8000,`${task.provider.name}网页未接受发送，题目仍在输入框；请重试本模型。`);
      if(!current(task))return;
      task.submitted=true;
      hasPendingPaste();
      console.info('[并答诊断]', JSON.stringify({ ...diagnostic, phase: 'after-send' }));
      update(task, 'generating');
    } catch (error) { if (current(task)) { releasePage(task); update(task, 'error', task.text, error.message); } }
  }
  function exactSelector(element) {
    const escape = value => CSS.escape(value);
    if (element.id && document.querySelectorAll(`#${escape(element.id)}`).length === 1) return `#${escape(element.id)}`;
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const tag = node.localName;
      const siblings = [...node.parentElement.children].filter(sibling => sibling.localName === tag);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      const selector = parts.join(' > ');
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    throw Error('无法生成唯一控件选择器。');
  }
  function calibrate(message) {
    if (!allowedFields.has(message.field) || typeof message.token !== 'string' || !message.token || !message.providerId) throw Error('校准参数无效。');
    clearCalibration?.();
    const hint = document.createElement('div');
    hint.textContent = `答题助手：点击要校准的 ${message.field} 控件，按 Esc 取消。`;
    Object.assign(hint.style, { position: 'fixed', top: '12px', left: '12px', zIndex: '2147483647', padding: '12px 18px', color: '#fff', background: '#263d57', borderRadius: '8px', pointerEvents: 'none' });
    document.documentElement.append(hint);
    const cleanup = () => { hint.remove(); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); clearCalibration = null; };
    const click = event => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      try { send({ type: 'site:calibrated', providerId: message.providerId, field: message.field, token: message.token, selector: exactSelector(event.target) }); } catch {}
      cleanup();
    };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cleanup(); } };
    document.addEventListener('click', click, true); document.addEventListener('keydown', key, true); clearCalibration = cleanup;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id) return false;
    try {
      if (message?.type === 'site:ping') respond({ ok: true, build: BUILD, contentRevision: CONTENT_REVISION });
      else if (message?.type === 'site:read' || message?.type === 'site:status') {
        const task = active;
        if (!task || !current(task) || message.providerId !== task.provider.id || message.runId !== task.runId || message.attempt !== task.attempt) {
          throw Error('本题采集上下文已失效，请重新发送本题后再读取。');
        }
        if(message.type==='site:status'){
          respond({ok:true,submitted:Boolean(task.submitted),status:task.status||'sending',done:Boolean(task.pageFinished),text:task.pageFinished?task.text:'',error:task.error||''});return false;
        }
        // A restarted background may read a queued task before it has sent. Never return the previous reply.
        if (!task.submitted) {
          respond({ ok: true, text: '', done: false, stopped: false, ambiguous: false,
            status: task.status === 'error' ? 'error' : 'sending', error: task.error || '' });
          return false;
        }
        if(task.pageFinished){respond({ok:true,text:task.text,done:true,stopped:false,ambiguous:false,status:'completed'});return false;}
        if(task.provider.id==='deepseek'){
          revealLatestReply(task).then(()=>respond(readReply(task))).catch(error=>respond({ok:false,error:error.message}));
          return true;
        }
        respond(readReply(task));
      }
      else if (message?.type === 'site:cancel') {
        const matches = active && message.runId === active.runId && message.attempt === active.attempt;
        if (matches) {
          const cancelledTask = active, provider = active.provider, previousGeneration = pageGeneration;
          cancel(); clearCalibration?.();
          if (message.stopGeneration) {
            interruptGeneration(null, provider, previousGeneration).then(() => {releasePage(cancelledTask); respond({ ok: true, cancelled: true, resetRequired: hasPendingPaste() || retainedPrompt(previousGeneration) });},
              error => {releasePage(cancelledTask); respond({ ok: false, cancelled: true, error: error.message });});
            return true;
          }
          releasePage(cancelledTask);
        }
        respond({ ok: true, cancelled: Boolean(matches) });
      }
      else if (message?.type === 'site:calibrate') { calibrate(message); respond({ ok: true }); }
      else if (message?.type === 'site:start') {
        if (message.build !== BUILD || message.contentRevision !== CONTENT_REVISION) throw Error('扩展页面适配版本不一致，请刷新模型网页后再发送。');
        if (new URL(message.provider?.url).origin !== location.origin || location.protocol !== 'https:') throw Error('当前页面与模型官方域名不匹配。');
        if (!message.provider?.id || typeof message.runId !== 'string' || !Number.isSafeInteger(message.attempt)) throw Error('任务标识无效。');
        const previousGeneration = pageGeneration;
        cancel(); clearCalibration?.();
        if (hasPendingPaste() || retainedPrompt(previousGeneration)) {
          // Reload the same conversation to cancel the website's asynchronous draft handlers.
          // Merely clearing this flag could let an old image arrive in the next question.
          interruptGeneration(null, message.provider, previousGeneration).then(() => respond({ ok: false, resetRequired: true, error: '上一题发送未完成，需要重置当前会话页面。' }),
            error => respond({ ok: false, error: error.message }));
          return true;
        }
        const task = { provider: message.provider, runId: message.runId, attempt: message.attempt, abort: new AbortController(), text: '', sent: false, submitted:false, previousGeneration };
        active = task; document.documentElement.setAttribute('data-bingda-active', pageToken(task)); pulsePage(); respond({ ok: true });
        queueMicrotask(() => { if (current(task)) execute(task, message); });
      } else return false;
    } catch (error) { respond({ ok: false, error: error.message }); }
    return false;
  });
})();

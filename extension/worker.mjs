import {createController} from './controller.mjs';
const controller=createController(chrome);
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type==='hub:state')return false;
  controller.handle(message,sender).then(respond).catch(error=>respond({ok:false,error:error.message}));
  return true;
});
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')}));

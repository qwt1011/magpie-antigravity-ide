'use strict';
// Pick the configured startup model using the normal selector once per panel.
// Does not access accounts, messages, network requests or response content.
if(process.env.MAGPIE_IDE_NATIVE_SOURCE==='managed-v3'){
  const {app,webContents,webFrameMain}=require('electron');
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const file=path.join(os.homedir(),'.antigravity-ide','magpie-ide.json');
  const armed=new WeakSet(),busy=new WeakSet();
  async function selectStartup(id){
    if(window.__magpieStartupPicker)return null;
    if(window.__APP_CONFIG__?.productName!=='antigravity'||!document.querySelector('script[src="/main.js"]'))return null;
    window.__magpieStartupPicker=true;
    const start=Date.now(); let touched=false,opened=false,trigger;
    const onUser=e=>{if(e.isTrusted)touched=true;};
    for(const type of ['pointerdown','keydown','touchstart'])document.addEventListener(type,onUser,true);
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    const visible=e=>e?.isConnected&&e.getClientRects().length&&!e.disabled;
    try{
      while(Date.now()-start<35000&&!touched){
        trigger=document.querySelector('[data-testid="model-selector-trigger"]');
        if(!visible(trigger)){await pause(200);continue;}
        if(trigger.getAttribute('data-model-label')===id)return 'already-default';
        if(trigger.getAttribute('aria-expanded')==='true')return 'menu-in-use';
        trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true,view:window}));
        trigger.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1,detail:1,view:window}));
        trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true,view:window}));
        trigger.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0,buttons:0,view:window}));
        await pause(100);
        if(trigger.getAttribute('aria-expanded')!=='true')trigger.click();
        opened=true;
        for(let i=0;i<30&&!touched;i++){
          const candidates=[...document.querySelectorAll('[data-testid="model-selector-item"]')];
          const item=candidates.find(e=>e.getAttribute('data-model-label')===id&&visible(e));
          if(item){item.click();opened=false;for(let n=0;n<20&&!touched;n++){if(trigger.getAttribute('data-model-label')===id)return 'selected-default';await pause(100);}return null;}
          await pause(100);
        }
        if(opened&&trigger.getAttribute('aria-expanded')==='true'){trigger.click();opened=false;}
        await pause(250);
      }
    }finally{
      for(const type of ['pointerdown','keydown','touchstart'])document.removeEventListener(type,onUser,true);
      if(opened&&!touched&&visible(trigger)&&trigger.getAttribute('aria-expanded')==='true')trigger.click();
    }
    return touched?'user-interacted':'timeout';
  }
  function scan(contents){if(armed.has(contents))return;armed.add(contents);
    async function frameReady(frame){if(!frame||busy.has(frame))return;let u;try{u=new URL(frame.url);}catch{return;}
      if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||!u.searchParams.has('extensionView'))return;
      let cfg;try{cfg=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return;}
      if(!cfg?.gatewayKey||typeof cfg.selectedModel!=='string'||!cfg.models?.some(m=>m.id===cfg.selectedModel))return;
      busy.add(frame);try{await frame.executeJavaScript('(async()=>{window.__magpieStartupPickerResult=await ('+selectStartup.toString()+')('+JSON.stringify(cfg.selectedModel)+');})()');}catch{}finally{busy.delete(frame);}
    }
    contents.on('did-frame-finish-load',(_e,_isMain,pid,rid)=>{try{void frameReady(webFrameMain.fromId(pid,rid));}catch{}});
    const all=()=>{try{for(const frame of contents.mainFrame.framesInSubtree)void frameReady(frame);}catch{}};
    contents.on('did-finish-load',all);all();
  }
  app.on('web-contents-created',(_e,c)=>scan(c));
  app.whenReady().then(()=>{for(const c of webContents.getAllWebContents())scan(c)});
}

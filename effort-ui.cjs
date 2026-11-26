'use strict';

// Runs only inside the local native chat panel. It adds a source-specific
// control next to the native model selector; no React internals or chat data.
module.exports = async function installEffortControl(config) {
  if (window.__magpieEffortControl) return;
  if (window.__APP_CONFIG__?.productName !== 'antigravity' || !document.querySelector('script[src="/main.js"]')) return;
  window.__magpieEffortControl = true;
  const names = {none:'关闭',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极致'};
  const state = {model:null, selected:{}, choices:{}, ready:false, busy:false, error:false};
  let trigger, button, popup;
  async function api(method, body) {
    const response = await fetch(config.url+'/control', {method, headers:{Authorization:'Bearer '+config.token, ...(body?{'Content-Type':'application/json'}:{})}, ...(body?{body:JSON.stringify(body)}:{})});
    if (!response.ok) throw Error('无法连接推理设置，请重新加载窗口');
    return response.json();
  }
  function close(){popup?.remove();popup=null;button?.setAttribute('aria-expanded','false');}
  function sync(){
    const next=document.querySelector('[data-testid="model-selector-trigger"]');
    if (!next) {close();return;}
    trigger=next;
    if (!button?.isConnected) {
      button=document.createElement('button');button.type='button';button.dataset.testid='magpie-effort-trigger';
      button.style.cssText='border:1px solid var(--vscode-widget-border,#5556);background:transparent;color:inherit;border-radius:5px;padding:2px 6px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer';
      button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');
      button.addEventListener('click',e=>{e.stopPropagation();if(popup)close();else void open();});
      trigger.parentElement.after(button);
    }
    const model=trigger.getAttribute('data-model-label');
    if(state.model!==model){state.model=model;close();}
    const levels=state.choices[model]||[];const effort=state.selected[model];
    const label=state.error?'推理：连接失败':!state.ready?'推理：连接中':levels.length?'推理：'+(effort?names[effort]||effort:'默认'):'推理：随模型';
    if(button.textContent!==label)button.textContent=label;
    const title=state.error?'请重新加载窗口后重试':levels.length?'仅影响本 IDE 的下一次模型请求；默认保留客户端参数。不改变 Magpie 默认设置。':'此模型没有声明可选推理档位，使用模型或供应商默认设置。';
    if(button.title!==title)button.title=title;
    button.setAttribute('aria-label',label);button.disabled=state.error||!state.ready||state.busy;
  }
  async function open(){
    close();const model=state.model,levels=state.choices[model]||[];
    popup=document.createElement('div');popup.dataset.testid='magpie-effort-menu';popup.setAttribute('role','menu');
    popup.style.cssText='position:fixed;z-index:2147483647;min-width:170px;max-width:260px;max-height:70vh;overflow:auto;background:var(--vscode-menu-background,#252526);color:var(--vscode-menu-foreground,#ddd);border:1px solid var(--vscode-menu-border,#555);border-radius:7px;padding:5px;box-shadow:0 4px 16px #0006';
    const title=document.createElement('div');title.textContent='推理强度';title.style.cssText='padding:5px 8px;font-size:12px;opacity:.7';popup.append(title);
    if(!levels.length){const info=document.createElement('div');info.textContent='此模型未声明可选档位';info.style.cssText='padding:6px 8px;font-size:12px';popup.append(info);}
    else for(const effort of [null,...levels]){
      const option=document.createElement('button');option.type='button';option.setAttribute('role','menuitemradio');option.setAttribute('aria-checked',String((state.selected[model]||null)===effort));option.dataset.effort=effort||'default';
      option.textContent=((state.selected[model]||null)===effort?'✓ ':'　')+(effort?names[effort]||effort:'默认（保留客户端设置）');
      option.style.cssText='display:block;width:100%;text-align:left;border:0;border-radius:4px;padding:6px 8px;font:inherit;font-size:12px;color:inherit;background:transparent;cursor:pointer';
      option.onpointerenter=()=>option.style.background='var(--vscode-menu-selectionBackground,#444)';option.onpointerleave=()=>option.style.background='transparent';
      option.onclick=async()=>{if(state.busy)return;state.busy=true;sync();try{const data=await api('POST',{model,effort});state.selected=data.selected||{};close();}catch(e){title.textContent=e.message;}finally{state.busy=false;sync();}};
      popup.append(option);
    }
    document.body.append(popup);button.setAttribute('aria-expanded','true');
    const rect=button.getBoundingClientRect(),height=popup.getBoundingClientRect().height;
    popup.style.left=Math.max(6,Math.min(rect.left,innerWidth-popup.offsetWidth-6))+'px';
    popup.style.top=Math.max(6,rect.top-height-5)+'px';
    popup.querySelector('button')?.focus();
  }
  document.addEventListener('pointerdown',e=>{if(popup&&!popup.contains(e.target)&&!button?.contains(e.target))close();},true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&popup){close();button?.focus();}},true);
  addEventListener('resize',close);
  const observer=new MutationObserver(sync);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-model-label']});
  sync();
  try{const data=await api('GET');state.choices=data.choices||{};state.selected=data.selected||{};state.ready=true;sync();}
  catch{state.error=true;sync();}
};

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');

const ns = 'magpieAntigravity', google = 'antigravity.panel.focus';
const configPath = () => path.join(os.homedir(), '.antigravity-ide', 'magpie-ide.json');
function readConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { throw Error('无法读取 Magpie 配置。请在 Magpie 的 Antigravity IDE 条目选择一个模型。'); }
  if (!c || !Array.isArray(c.models) || typeof c.gatewayKey !== 'string' || !c.gatewayKey.trim() || /[\r\n\0]/.test(c.gatewayKey)) throw Error('Magpie 尚未连接，或网关密钥无效。');
  let url; try { url = new URL(c.gatewayUrl); } catch { throw Error('Magpie 网关地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['/','/v1','/v1/'].includes(url.pathname)) throw Error('只支持本机 Magpie 网关。');
  const models = new Map();
  for (const m of c.models) if (typeof m?.id === 'string' && m.id.trim() && !/[\x00-\x1f\x7f]/.test(m.id)) models.set(m.id, typeof m.name === 'string' ? m.name : m.id);
  if (!models.has(c.selectedModel)) throw Error('Magpie 默认模型不在当前模型列表，请重新选择。');
  return {models, selected:c.selectedModel, url:url.origin, key:c.gatewayKey};
}
function cliPath() {
  const user = vscode.workspace.getConfiguration(ns).inspect('agyPath')?.globalValue;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = user ? [user] : [path.join(os.homedir(), '.gemini','bin','agy.exe'),path.join(base,'Programs','Antigravity IDE','bin','agy.exe')];
  for (const file of candidates) if (typeof file === 'string' && path.isAbsolute(file) && path.basename(file).toLowerCase() === 'agy.exe' && fs.statSync(file,{throwIfNoEntry:false})?.isFile()) return file;
  throw Error('找不到官方 agy.exe；可在用户设置中指定 magpieAntigravity.agyPath。');
}
async function openCli(context, mode) {
  try {
    const binary=cliPath(); let magpie;
    if(mode==='magpie') {
      const executable=path.join(process.env.LOCALAPPDATA,'Programs','magpie','magpie.exe');
      const {execFile}=require('node:child_process');
      const stdout=await new Promise((resolve,reject)=>execFile(executable,['agy','env'],{windowsHide:true,timeout:12000,maxBuffer:1024*1024},(err,out)=>err?reject(Error('无法读取 Magpie CLI 配置。请确认 Magpie 已安装并连接 Antigravity CLI。')):resolve(out)));
      magpie=Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
    }
    const {session}=require(path.join(context.extensionPath,'cli-session.cjs'));
    const spec=session({mode,home:os.homedir(),localData:process.env.LOCALAPPDATA,env:process.env,magpie});
    const networkProxy=vscode.workspace.getConfiguration('http').inspect('proxy')?.globalValue;
    if(typeof networkProxy==='string'&&networkProxy){
      let proxy;try{proxy=new URL(networkProxy);}catch{}
      if(proxy?.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(proxy.hostname)&&!proxy.username&&!proxy.password&&!proxy.search&&!proxy.hash&&proxy.pathname==='/'){
        for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'])if(!process.env[key])spec.env[key]=proxy.origin;
      }
    }
    const workspace=(vscode.workspace.workspaceFolders||[]).find(f=>f.uri.scheme==='file');
    const term=vscode.window.createTerminal({name:mode==='google'?'Antigravity CLI · Google 账号':'Antigravity CLI · Magpie',shellPath:binary,shellArgs:spec.args,env:spec.env,cwd:workspace?.uri.fsPath||os.homedir(),iconPath:new vscode.ThemeIcon('terminal')});
    term.show();
  } catch(error) {void vscode.window.showWarningMessage(error instanceof Error?error.message:'无法打开 Antigravity CLI。');}
}
function activate(context) {
  context.subscriptions.push(...['google','magpie'].map(mode=>vscode.commands.registerCommand(ns+'.open'+(mode==='google'?'Google':'Magpie')+'Cli',()=>openCli(context,mode))));
  if (process.env.MAGPIE_IDE_NATIVE_SOURCE==='managed-v3') return activateNative(context);
  const status = vscode.window.createStatusBarItem('magpieAntigravity.model',vscode.StatusBarAlignment.Right,65);
  const output = vscode.window.createOutputChannel('Magpie · Antigravity IDE');
  const sessions = new Map(); let selection = null, lastMagpie = null, chain = Promise.resolve(), disposed = false;
  status.name = 'Magpie 模型'; status.command = ns+'.pickModel';
  const display = () => {
    status.text = '模型：' + (selection?.kind === 'google' ? 'Google' : selection?.id || '选择模型');
    status.tooltip = selection?.kind === 'google' ? 'Google 原生聊天侧栏。点击可回到 Magpie。' : '选择 Magpie 模型或打开 Google 原生聊天。仅本窗口生效。';
    status.show();
  };
  const forget = record => { if (record) { try {fs.rmSync(record.file,{force:true});}catch{} } };
  async function showModel(id, {fresh=false, startup=false}={}) {
    const c = readConfig(); id = id || c.selected;
    if (!c.models.has(id)) throw Error('此模型已从 Magpie 移除，请重新选择。');
    const command = cliPath();
    let prior = sessions.get(id);
    if (prior && !fresh && (prior.url !== c.url || prior.key !== c.key)) throw Error('此会话的网关配置已经更换。请用“新会话”重新连接。');
    if (prior && fresh) {
      if (await vscode.window.showWarningMessage('结束这个模型的当前会话，重新开始？',{modal:true},'新会话') !== '新会话') return;
      prior.term.dispose(); forget(prior); sessions.delete(id); prior=null;
    }
    if (disposed) return;
    if (!prior) {
      const folder = context.globalStorageUri.fsPath;
      fs.mkdirSync(folder,{recursive:true,mode:0o700});
      const file = path.join(folder,'session-'+randomUUID()+'.json');
      fs.writeFileSync(file,JSON.stringify({modelProvider:'gemini',customModelsConfig:{customModels:{['magpie/'+id]:{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',modelName:id}}}}),{flag:'wx',mode:0o600});
      const workspace = (vscode.workspace.workspaceFolders || []).find(f=>f.uri.scheme==='file');
      let term;
      try {term=vscode.window.createTerminal({name:'Magpie · '+id,shellPath:command,shellArgs:['--settings',file,'--model','magpie/'+id],cwd:workspace?.uri.fsPath || os.homedir(),isTransient:true, env:{GEMINI_API_KEY:c.key,GOOGLE_GEMINI_BASE_URL:c.url,NO_PROXY:[process.env.NO_PROXY,'localhost','127.0.0.1','::1'].filter(Boolean).join(',')},iconPath:new vscode.ThemeIcon('terminal')});}
      catch {forget({file});throw Error('IDE 无法创建模型终端。请检查终端配置。');}
      prior={term,file,url:c.url,key:c.key};sessions.set(id,prior);
    }
    selection={kind:'magpie',id};lastMagpie=id;prior.term.show(startup);display();
    output.appendLine((startup?'启动默认：':'当前模型：')+id);
  }
  async function showGoogle() {
    const own=vscode.window.activeTerminal;
    await vscode.commands.executeCommand(google);
    if ([...sessions.values()].some(s=>s.term===own)) own.hide();
    selection={kind:'google'};display();output.appendLine('已打开 Google 原生聊天。');
  }
  async function pick() {
    let c,configError; try {c=readConfig();}catch(e){configError=e.message;}
    const items=[...(c?[{label:'$(star-full) '+c.selected,description:'Magpie 启动默认',id:c.selected}]:[]),{label:'$(account) Google 账号模型',description:'打开原生聊天侧栏',native:true},...(c?[...c.models].filter(([id])=>id!==c.selected).map(([id,name])=>({label:id,description:name,id})):[])];
    const choice=await vscode.window.showQuickPick(items,{title:'选择本窗口的模型',placeHolder:configError || '切换不改变 Magpie 默认值；回到已打开的模型可继续对话。',matchOnDescription:true});
    if (choice) {if(choice.native) await showGoogle();else await showModel(choice.id);}
  }
  const guard = fn => (...args) => {
    const op=async()=>{if(disposed) return;try{return await fn(...args);}catch(err){const msg=err instanceof Error?err.message:'操作失败。';output.appendLine(msg);display();void vscode.window.showWarningMessage(msg+'（命令面板：Magpie）');}};
    const pending=chain.then(op,op);chain=pending.catch(()=>{});return pending;
  };
  display();
  const actions={pickModel:pick,useGoogle:showGoogle,useModel:id=>showModel(id),focusModelTerminal:()=>showModel(lastMagpie),restartModelTerminal:()=>showModel(lastMagpie,{fresh:true}),refresh:()=>{const c=readConfig();display();void vscode.window.showInformationMessage('Magpie 启动默认：'+c.selected+'。当前会话保持原样。');},openSettings:()=>vscode.commands.executeCommand('workbench.action.openSettings','@ext:'+context.extension.id)};
  context.subscriptions.push(output,status,...Object.entries(actions).map(([k,fn])=>vscode.commands.registerCommand(ns+'.'+k,guard(fn))),vscode.window.onDidCloseTerminal(term=>{for(const [id,s] of sessions){if(s.term===term){sessions.delete(id);forget(s);if(selection?.id===id){selection=null;display();}break;}}}),{dispose(){disposed=true;for(const s of sessions.values()){s.term.dispose();forget(s);}sessions.clear();}});
  if(vscode.workspace.getConfiguration(ns).get('autoStart',true)) return guard(()=>showModel(null,{startup:true}))();
}
function activateNative(context) {
  const status=vscode.window.createStatusBarItem('magpieAntigravity.native',vscode.StatusBarAlignment.Right,65);
  status.name='原生聊天来源';status.command=ns+'.pickModel';status.show();
  const file=configPath(),run=process.env.MAGPIE_IDE_RUN_ID;
  const sessionFile=path.join(process.env.LOCALAPPDATA,'MagpieAntigravityIDE','sessions',run+'-'+process.pid+'.json');
  let timer,current;
  function update(){
    try{current=JSON.parse(fs.readFileSync(sessionFile,'utf8'));}catch{current=null;}
    let next=null,bad=false;
    try{const c=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};if(c?.selectedModel||c?.gatewayKey||c?.gatewayUrl)next=readConfig();}catch{bad=true;}
    const ids=next?[next.selected,...Array.from(next.models.keys()).filter(id=>id!==next.selected)]:[];
    const changed=bad||!!current&&((current.mode==='magpie')!==!!next||current.selected!==(next?.selected??null)||JSON.stringify(current.ids)!==JSON.stringify(ids));
    status.text='$(comment-discussion) '+(!current?'原生侧栏启动中':current.mode==='magpie'?'Magpie · '+current.ids.length+' 个模型':'Google 账号模式')+(changed?' · 待刷新':'');
    status.tooltip=changed?'Magpie 配置已更改。用命令“Magpie: 刷新原生模型列表（重新加载窗口）”应用。':(current?.mode==='magpie'?'启动默认：'+current.selected+'。当前对话使用原生下拉框勾选的模型。':'原生账号模式；可用模型取决于 Google 登录和授权。');
  }
  const reload=async()=>{if(await vscode.window.showInformationMessage('重新加载当前窗口以应用 Magpie 的连接和可见模型。请先等进行中的回复结束。','重新加载')==='重新加载')return vscode.commands.executeCommand('workbench.action.reloadWindow');};
  const focus=()=>vscode.commands.executeCommand(google);
  const info=()=>vscode.window.showInformationMessage('请在原生聊天输入框旁的模型列表选择本次模型；连接或断开在 Magpie 的 Antigravity IDE 条目中操作。');
  const actions={pickModel:focus,useGoogle:info,useModel:info,focusModelTerminal:()=>openCli(context,'magpie'),restartModelTerminal:()=>openCli(context,'magpie'),refresh:reload,openSettings:()=>vscode.commands.executeCommand('workbench.action.openSettings','@ext:'+context.extension.id)};
  context.subscriptions.push(status,...Object.entries(actions).map(([k,fn])=>vscode.commands.registerCommand(ns+'.'+k,fn)));
  const watchers=[];
  for(const [p,name] of [[path.dirname(file),path.basename(file)],[path.dirname(sessionFile),path.basename(sessionFile)]]){try{const w=fs.watch(p,{persistent:false},(_,fn)=>{if(!fn||String(fn).toLowerCase()===name.toLowerCase()){clearTimeout(timer);timer=setTimeout(update,200);}});w.on('error',()=>{});watchers.push(w);}catch{}}
  let ticks=0;const warm=setInterval(()=>{update();if(current||++ticks>=40)clearInterval(warm);},750);
  context.subscriptions.push({dispose(){clearInterval(warm);clearTimeout(timer);for(const w of watchers)w.close();}}); update();return focus().catch(()=>{});
}
module.exports={activate};

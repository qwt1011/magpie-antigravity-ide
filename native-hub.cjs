'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {prepare} = require('./native-profile.cjs');
const {start} = require('./effort-gateway.cjs');
const active = new Map();

// Called at the built-in extension's agy --hub spawn. Other IDE processes,
// terminals and ordinary agy sessions retain their original home/environment.
module.exports = async function nativeHub(env, hubPort) {
  const home = env.USERPROFILE, data = path.join(env.LOCALAPPDATA,'MagpieAntigravityIDE');
  const privateHome = path.join(data,'hub-home');
  const source = path.join(home,'.antigravity-ide','magpie-ide.json');
  if (Object.keys(env).some(k=>/^AGY_LLM_GATEWAY_/i.test(k))) throw Error('External gateway settings conflict with Magpie IDE.');
  const state = prepare({home,privateHome,agentFile:source});
  const child = {...env, USERPROFILE:privateHome, HOME:privateHome};
  const run=env.MAGPIE_IDE_RUN_ID;
  if(!/^[a-f0-9]{32}$/i.test(run||'')) throw Error('Invalid native IDE run ID.');
  if (!Number.isInteger(hubPort) || hubPort < 1 || hubPort > 65535) throw Error('Invalid native hub port.');
  const old=active.get(run);if(old){await old.close();active.delete(run);}
  let control;
  if (state.mode === 'magpie') {
    // Read the committed snapshot, not the live Agent file a second time.
    const cfg=JSON.parse(fs.readFileSync(path.join(privateHome,'.gemini','config','config.json'),'utf8'));
    if (!cfg.gateway?.enabled || cfg.models.defaultModelId!==state.selected) throw Error('Model settings changed while starting. Reload the window.');
    control=await start({url:cfg.gateway.url,key:cfg.gateway.apiKey,models:cfg.models.list.map(m=>({id:m.modelId,efforts:m.efforts||[]})),allowedOrigin:'http://127.0.0.1:'+hubPort});
    active.set(run,control);
    Object.assign(child,{AGY_LLM_GATEWAY_MODELS:cfg.models.list.map(m=>m.modelId).join(','),AGY_LLM_GATEWAY_WIRE_PROTOCOL:'openai',AGY_LLM_GATEWAY_URL:control.url,AGY_LLM_GATEWAY_API_KEY:cfg.gateway.apiKey});
  }
  const folder=path.join(data,'sessions'); fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,run+'-'+process.pid+'.json'), tmp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify({mode:state.mode,selected:state.selected??null,ids:state.ids,at:Date.now()}),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
  const controlFile=path.join(data,'effort-control.json');
  if(control){const value={run,url:control.url,token:control.token,origin:'http://127.0.0.1:'+hubPort};fs.writeFileSync(controlFile,JSON.stringify(value),{mode:0o600});}
  else if(fs.existsSync(controlFile))fs.unlinkSync(controlFile);
  return child;
};

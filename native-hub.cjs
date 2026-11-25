'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {prepare} = require('./native-profile.cjs');

// Called at the built-in extension's agy --hub spawn. Other IDE processes,
// terminals and ordinary agy sessions retain their original home/environment.
module.exports = function nativeHub(env) {
  const home = env.USERPROFILE, data = path.join(env.LOCALAPPDATA,'MagpieAntigravityIDE');
  const privateHome = path.join(data,'hub-home');
  const source = path.join(home,'.antigravity-ide','magpie-ide.json');
  if (Object.keys(env).some(k=>/^AGY_LLM_GATEWAY_/i.test(k))) throw Error('External gateway settings conflict with Magpie IDE.');
  const state = prepare({home,privateHome,agentFile:source});
  const child = {...env, USERPROFILE:privateHome, HOME:privateHome};
  if (state.mode === 'magpie') {
    // Read the committed snapshot, not the live Agent file a second time.
    const cfg=JSON.parse(fs.readFileSync(path.join(privateHome,'.gemini','config','config.json'),'utf8'));
    if (!cfg.gateway?.enabled || cfg.models.defaultModelId!==state.selected) throw Error('Model settings changed while starting. Reload the window.');
    Object.assign(child,{AGY_LLM_GATEWAY_MODELS:cfg.models.list.map(m=>m.modelId).join(','),AGY_LLM_GATEWAY_WIRE_PROTOCOL:'openai',AGY_LLM_GATEWAY_URL:cfg.gateway.url,AGY_LLM_GATEWAY_API_KEY:cfg.gateway.apiKey});
  }
  const run=env.MAGPIE_IDE_RUN_ID;
  if(!/^[a-f0-9]{32}$/i.test(run||'')) throw Error('Invalid native IDE run ID.');
  const folder=path.join(data,'sessions'); fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,run+'-'+process.pid+'.json'), tmp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify({mode:state.mode,selected:state.selected??null,ids:state.ids,at:Date.now()}),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
  return child;
};

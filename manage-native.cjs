'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const root=path.join(process.env.LOCALAPPDATA,'Programs','Antigravity IDE','resources','app');
const repo=__dirname, me=path.join(repo,'.local','checkpoints','native-adapter-2.7.0');
const base=path.join(root,'extensions','agy','vscode'),entry=path.join(base,'extension.js');
const commit='71bedb45923debaf49871bdcb7c7d3a47918e247', original='bfe65af77e4637e0c17fb395a89365f7bf78cbe512c5a230c225b188a767a8e7';
const before='env:a.serverEnv,shell:!1', after='env:a.serverEnv.MAGPIE_IDE_NATIVE_SOURCE==="managed-v3"?await require("./magpie-native/native-hub.cjs")(a.serverEnv,a.targetPort):a.serverEnv,shell:!1';
const helpers=['native-hub.cjs','native-profile.cjs','startup-hook.cjs','effort-gateway.cjs','effort-ui.cjs'], dest=path.join(base,'magpie-native'), record=path.join(me,'installed.json'), backup=path.join(me,'extension.js');
const mainFile=path.join(root,'out','main.js'),mainBackup=path.join(me,'main.js');
const startupMarker='\n/* MAGPIE_IDE_NATIVE_STARTUP */\nimport("../extensions/agy/vscode/magpie-native/startup-hook.cjs").catch(() => {});\n/* MAGPIE_IDE_NATIVE_STARTUP_END */\n';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'), at=f=>fs.existsSync(f)?hash(fs.readFileSync(f)):null;
function write(file,bytes){const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,bytes,{flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
function main(action){
 const product=JSON.parse(fs.readFileSync(path.join(root,'product.json'),'utf8'));
 if(product.commit!==commit||product.ideVersion!=='2.7.0')throw Error('Unsupported IDE build; refusing to change or launch it in managed mode.');
 const state=fs.existsSync(record)?JSON.parse(fs.readFileSync(record,'utf8')):null;
 const active=!!state&&at(entry)===state.patched&&(!state.mainAfter||at(mainFile)===state.mainAfter)&&Object.entries(state.files).every(([n,h])=>at(path.join(dest,n))===h);
 if(action==='status'||action==='check'){if(action==='check'&&!active)throw Error('Native model adapter is not installed for this build.');console.log(JSON.stringify({installed:active,version:product.ideVersion}));return;}
 if(action==='restore'){
   if(!state||at(backup)!==original||at(entry)!==state.patched||state.mainAfter&&(at(mainFile)!==state.mainAfter||at(mainBackup)!==state.mainBefore))throw Error('No matching original file; refusing to overwrite.');
   if(state.mainAfter)write(mainFile,fs.readFileSync(mainBackup));
   write(entry,fs.readFileSync(backup));for(const [n,h] of Object.entries(state.files))if(at(path.join(dest,n))===h)fs.unlinkSync(path.join(dest,n));
   if(!fs.readdirSync(dest).length)fs.rmdirSync(dest);fs.unlinkSync(record);console.log('Native adapter restored.');return;
 }
 if(action!=='install')throw Error('Use install, status, check or restore.');
 if(active){if(helpers.every(n=>at(path.join(repo,n))===state.files[n])){console.log('Native adapter already matches.');return;}throw Error('Restore the previous adapter before updating.');}
 if(state||fs.existsSync(dest)||at(entry)!==original)throw Error('Built-in extension was changed; refusing to overwrite.');
 const raw=fs.readFileSync(entry),src=raw.toString('utf8');if(src.split(before).length!==2)throw Error('Unknown hub start code.');
 const mainRaw=fs.readFileSync(mainFile),mainText=mainRaw.toString('utf8');if(mainText.includes('MAGPIE_IDE_NATIVE_STARTUP'))throw Error('Unknown existing startup adapter.');
 const patched=src.replace(before,after);const files=Object.fromEntries(helpers.map(n=>[n,at(path.join(repo,n))]));if(Object.values(files).some(x=>!x))throw Error('Missing helper.');
 fs.mkdirSync(me,{recursive:true});if(!fs.existsSync(backup))fs.writeFileSync(backup,raw,{flag:'wx'});if(at(backup)!==original)throw Error('Original backup mismatch.');
 if(fs.existsSync(mainBackup)&&at(mainBackup)!==hash(mainRaw))throw Error('Startup backup baseline changed.');if(!fs.existsSync(mainBackup))fs.writeFileSync(mainBackup,mainRaw,{flag:'wx'});
 fs.mkdirSync(dest);const stateNext={patched:hash(patched),files,mainBefore:hash(mainRaw),mainAfter:hash(mainText+startupMarker)};
 try{for(const n of helpers)fs.copyFileSync(path.join(repo,n),path.join(dest,n),fs.constants.COPYFILE_EXCL);write(record,JSON.stringify(stateNext,null,2));write(entry,patched);write(mainFile,mainText+startupMarker);}catch(e){if(at(mainFile)===stateNext.mainAfter)write(mainFile,mainRaw);if(at(entry)===stateNext.patched)write(entry,raw);if(at(entry)===original){for(const n of helpers){const f=path.join(dest,n);if(at(f)===files[n])fs.unlinkSync(f);}if(!fs.readdirSync(dest).length)fs.rmdirSync(dest);fs.rmSync(record,{force:true});}throw e;}
 console.log('Installed native hub configuration adapter.');
}
try{main(process.argv[2]||'status');}catch(e){console.error(e.message);process.exitCode=1;}

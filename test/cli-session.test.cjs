'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {session}=require('../cli-session.cjs');

test('CLI sources isolate App routing, retain account links and never change shared settings',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-cli-source-'));
  try {
    const home=path.join(root,'home'),localData=path.join(home,'AppData','Local');
    const shared=path.join(home,'.gemini','config','config.json'),account=path.join(home,'.gemini','antigravity');
    fs.mkdirSync(path.dirname(shared),{recursive:true});fs.mkdirSync(account,{recursive:true});
    const body=JSON.stringify({gateway:{enabled:true,url:'http://127.0.0.1:1234',apiKey:'fixture-shared'},models:{listSource:'shared-only'},userSettings:{telemetry:false}});
    fs.writeFileSync(shared,body);const settings=path.join(root,'magpie-settings.json');fs.writeFileSync(settings,'{}');
    const env={AGY_LLM_GATEWAY_URL:'http://127.0.0.1:1234',AGY_LLM_GATEWAY_API_KEY:'fixture',GEMINI_API_KEY:'fixture',GOOGLE_GEMINI_BASE_URL:'fixture',MAGPIE_IDE_NATIVE_SOURCE:'managed-v3'};
    const google=session({mode:'google',home,localData,env});
    assert.deepEqual(google.args,[]);
    for(const name of Object.keys(env))assert.equal(google.env[name],null);
    assert.equal(fs.realpathSync(path.join(google.env.HOME,'.gemini','antigravity')),fs.realpathSync(account));
    const read=spec=>JSON.parse(fs.readFileSync(path.join(spec.env.HOME,'.gemini','config','config.json'),'utf8'));
    assert.deepEqual(read(google).gateway,{enabled:false});assert.deepEqual(read(google).models,{});
    const magpie=session({mode:'magpie',home,localData,env,magpie:{model:'fixture/model',settings,GEMINI_API_KEY:'fixture-cli',GOOGLE_GEMINI_BASE_URL:'http://127.0.0.1:3425'}});
    assert.notEqual(magpie.env.HOME,google.env.HOME);
    assert.deepEqual(magpie.args,['--settings',settings,'--model','fixture/model']);
    assert.equal(magpie.env.GEMINI_API_KEY,'fixture-cli');assert.deepEqual(read(magpie).gateway,{enabled:false});
    const cliFile=path.join(google.env.HOME,'.gemini','antigravity-cli','settings.json');
    fs.writeFileSync(cliFile,JSON.stringify({modelProvider:'custom',model:'old-model',customModelsConfig:{},colorScheme:'dark'}));
    session({mode:'google',home,localData,env});
    assert.deepEqual(JSON.parse(fs.readFileSync(cliFile,'utf8')),{colorScheme:'dark'});
    assert.equal(fs.readFileSync(shared,'utf8'),body);
    assert.throws(()=>session({mode:'magpie',home,localData,env,magpie:{}}),/Antigravity CLI/);
  } finally {
    // Node removes directory junctions themselves; it never traverses their targets.
    fs.rmSync(root,{recursive:true,force:true});
  }
});

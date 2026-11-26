import assert from 'node:assert/strict';
import test from 'node:test';
import { agent, connect } from '../antigravity-ide.agent.js';

test('Magpie owns a dedicated config; an IDE-side selection is not an input', () => {
  const model = { id:'fixture/model', name:'Fixture', context:500, output:52, images:false, efforts:['high','low','high','invalid'], credential:'never copied' };
  const gateway = {url:'http://127.0.0.1:3333',key:'fixture-key'};
  const result = connect({gateway,model,models:[null,model,model,{}, {id:'other/fixture'}], ideSelection:'native'});
  assert.equal(agent.config,'~/.antigravity-ide/magpie-ide.json');
  assert.equal(result[agent.model],model.id);
  assert.deepEqual(result.models,[{id:model.id,name:'Fixture',context:500,output:52,images:false,efforts:['low','high']},{id:'other/fixture',name:'other/fixture'}]);
  assert.equal(result.gatewayKey,gateway.key);
  assert.throws(()=>connect({gateway:{...gateway,key:''},model}),/key/);
});

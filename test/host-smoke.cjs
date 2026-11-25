// Run as --extensionTestsPath in an isolated Antigravity IDE window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const vscode = require('vscode');
exports.run = async () => {
  const file = path.join(os.homedir(),'.antigravity-ide','magpie-ide.json');
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash(); const { selectedModel, models } = JSON.parse(fs.readFileSync(file));
  const ext = vscode.extensions.getExtension('local-workspace.magpie-antigravity-ide-model-terminal');
  await ext.activate();
  const terminal = id => vscode.window.terminals.find(t=>t.name==='Magpie · '+id);
  const delay = n=>new Promise(r=>setTimeout(r,n));
  async function live(id){for(let i=0;i<50;i++){const t=terminal(id);if(t && await t.processId)return t;await delay(200);}throw Error('Missing terminal '+id);}
  const first = await live(selectedModel);
  assert.equal(first.creationOptions.shellArgs.at(-1),'magpie/'+selectedModel);
  const other = models.find(m=>m.id!==selectedModel);
  assert(other);
  await vscode.commands.executeCommand('magpieAntigravity.useModel',other.id);
  const second=await live(other.id);
  assert.equal(second.creationOptions.shellArgs.at(-1),'magpie/'+other.id);
  const settings = JSON.parse(fs.readFileSync(second.creationOptions.shellArgs[1]));
  assert.equal(settings.customModelsConfig.customModels['magpie/'+other.id].modelName,other.id);
  assert.equal(hash(),before);
  await vscode.commands.executeCommand('magpieAntigravity.useGoogle');
  assert.equal(vscode.window.terminals.filter(t=>t.name.startsWith('Magpie · ')).length,2);
  assert.equal(hash(),before);
  await vscode.commands.executeCommand('magpieAntigravity.useModel',selectedModel);
  assert.equal((await live(selectedModel)),first);
  assert.equal((await live(other.id)),second);
  // Leave a temporary choice so a second process with the same IDE profile can verify startup behavior.
  await vscode.commands.executeCommand('magpieAntigravity.useModel',other.id);
  assert.equal(hash(),before);
  console.log('MAGPIE_HOST_SMOKE_OK');
};

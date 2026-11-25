'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepare } = require('../native-profile.cjs');

const temporary = [];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function fixture() {
  // Hosted Windows runners may expose TEMP through an 8.3 alias. Fixtures use
  // the canonical path so the production junction checks remain strict.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-native-profile-')));
  temporary.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'bin'));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'));
  fs.mkdirSync(path.join(home, '.gemini', 'config', 'projects'));
  return {
    root,
    home,
    privateHome: path.join(home, 'AppData', 'Local', 'MagpieAntigravityIDE', 'hub-home'),
    agentFile: path.join(root, 'agent.json'),
  };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function files(value) {
  return {
    config: path.join(value.privateHome, '.gemini', 'config', 'config.json'),
    settings: path.join(value.privateHome, '.antigravity', 'settings.json'),
  };
}

function connection() {
  return {
    selectedModel: 'model/b',
    models: [
      { id: 'model/a', name: 'Alpha', context: 4096, output: 512, images: true, group: 'fixture' },
      { id: 'model/b', name: 'Beta', context: 8192, output: 1024 },
      { id: 'model/a', name: 'duplicate' },
    ],
    gatewayUrl: 'http://127.0.0.1:3456/v1',
    gatewayKey: 'top-secret-key',
  };
}

function run(value, checkOnly = false) {
  return prepare({
    home: value.home,
    privateHome: value.privateHome,
    agentFile: value.agentFile,
    checkOnly,
  });
}

test.after(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
});

test('checkOnly is read-only and missing or empty Magpie config means Google', () => {
  const value = fixture();
  const missing = run(value, true);
  assert.deepEqual({ mode: missing.mode, selected: missing.selected, count: missing.count }, {
    mode: 'google', selected: null, count: 0,
  });
  assert.match(missing.signature, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(value.privateHome), false);

  write(value.agentFile, {});
  assert.equal(run(value, true).mode, 'google');
  assert.equal(fs.existsSync(value.privateHome), false);
});

test('connection replaces routing fields and copies all safe first-settings', () => {
  const value = fixture();
  write(value.agentFile, connection());
  write(path.join(value.home, '.gemini', 'config', 'config.json'), {
    userSettings: {
      permissionPreset: 'full',
      enableTerminalSandbox: false,
      telemetry: false,
      apiKey: 'must-not-copy',
    },
    plugins: { alpha: { enabled: true } },
    auth: { token: 'must-not-copy' },
    gateway: { enabled: true, listSource: 'must-not-copy' },
  });

  const result = run(value);
  assert.equal(result.mode, 'magpie');
  assert.equal(result.selected, 'model/b');
  assert.deepEqual(result.ids, ['model/b', 'model/a']);
  assert.equal(result.count, 2);
  assert.equal(JSON.stringify(result).includes('top-secret-key'), false);

  const config = read(files(value).config);
  const settings = read(files(value).settings);
  assert.deepEqual(config.userSettings, {
    permissionPreset: 'full',
    enableTerminalSandbox: false,
    telemetry: false,
    apiKey: 'must-not-copy',
  });
  assert.deepEqual(config.plugins, { alpha: { enabled: true } });
  assert.equal(config.auth, undefined);
  assert.deepEqual(config.gateway, {
    enabled: true,
    url: 'http://127.0.0.1:3456',
    apiKey: 'top-secret-key',
    wireProtocol: 'openai',
  });
  assert.equal(config.models.defaultModelId, 'model/b');
  assert.deepEqual(config.models.list.map(({ modelId }) => modelId), ['model/b', 'model/a']);
  assert.equal(config.models.list[1].displayName, 'Alpha');
  assert.equal(settings.models.defaultModelId, 'model/b');
  assert.deepEqual(settings.models.list, config.models.list);
  assert.deepEqual(settings.gateway, config.gateway);
  assert.equal(fs.readdirSync(path.dirname(files(value).config)).some((name) => name.endsWith('.tmp')), false);
});

test('disconnect replaces routing and preserves every non-routing field in both files', () => {
  const value = fixture();
  write(value.agentFile, connection());
  write(files(value).config, {
    userSettings: { permissionPreset: 'full', enableTerminalSandbox: true },
    plugins: { keep: true },
    gateway: { enabled: true, listSource: 'old', custom: 'gone' },
    models: { defaultModelId: 'old', list: [], listSource: 'old', custom: 'gone' },
    custom: { config: true },
  });
  write(files(value).settings, {
    gateway: { enabled: true, listSource: 'old', custom: 'gone' },
    models: { defaultModelId: 'old', list: [], custom: 'gone' },
    editor: { fontSize: 16 },
  });
  write(value.agentFile, {});
  fs.mkdirSync(path.join(value.privateHome, '.magpie-antigravity-ide'), { recursive: true });
  write(path.join(value.privateHome, '.magpie-antigravity-ide', 'native-profile.json'), {
    product: 'magpie-antigravity-ide', version: 1,
  });

  const result = run(value);
  assert.equal(result.mode, 'google');
  assert.equal(result.selected, null);
  assert.deepEqual(result.ids, []);
  const config = read(files(value).config);
  const settings = read(files(value).settings);
  assert.deepEqual(config.userSettings, { permissionPreset: 'full', enableTerminalSandbox: true });
  assert.deepEqual(config.plugins, { keep: true });
  assert.deepEqual(config.custom, { config: true });
  assert.deepEqual(config.gateway, { enabled: false });
  assert.deepEqual(config.models, {});
  assert.equal(hasOwn(config.gateway, 'listSource'), false);
  assert.deepEqual(settings, { editor: { fontSize: 16 }, gateway: { enabled: false }, models: {} });
});

test('malformed and incomplete Magpie files fail before private writes', () => {
  const value = fixture();
  write(value.agentFile, '<');
  assert.throws(() => run(value), /valid JSON/);
  assert.equal(fs.existsSync(value.privateHome), false);

  write(value.agentFile, { gatewayUrl: 'http://127.0.0.1:3456/v1', selectedModel: 'model/a' });
  assert.throws(() => run(value), /incomplete/);
  write(value.agentFile, { ...connection(), selectedModel: 'model/hidden' });
  assert.throws(() => run(value), /selected model/);
  assert.equal(fs.existsSync(value.privateHome), false);
  write(value.agentFile, { ...connection(), gatewayUrl: 'https://example.com/v1' });
  assert.throws(() => run(value), /loopback/);
});

test('both approved privateHome roots work and shared home paths are rejected', () => {
  const value = fixture();
  write(value.agentFile, connection());
  const native = path.join(value.home, '.antigravity-ide', 'magpie-native', 'hub-home');
  assert.equal(prepare({ home: value.home, privateHome: native, agentFile: value.agentFile, checkOnly: true }).mode, 'magpie');
  assert.equal(run(value, true).mode, 'magpie');
  for (const bad of [
    path.join(value.home, '.gemini'),
    path.join(value.home, '.antigravity'),
    path.join(value.home, 'somewhere'),
    path.join(value.home, 'AppData', 'Local', 'Other', 'hub-home'),
  ]) {
    assert.throws(() => prepare({ home: value.home, privateHome: bad, agentFile: value.agentFile, checkOnly: true }), /privateHome/);
  }
});

test('junctions share existing account, bin and config roots without linking config', { skip: process.platform !== 'win32' }, () => {
  const value = fixture();
  write(value.agentFile, connection());
  write(path.join(value.home, '.gemini', 'antigravity', 'session.json'), { account: 'kept' });
  write(path.join(value.home, '.gemini', 'config', 'config.json'), { projects: {}, userSettings: { enableTerminalSandbox: true } });
  run(value);

  for (const name of ['antigravity', 'bin', 'projects']) {
    const parts=name==='projects'?['.gemini','config',name]:['.gemini',name];const link = path.join(value.privateHome,...parts);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(
      fs.realpathSync.native(link).toLowerCase(),
      fs.realpathSync.native(path.join(value.home,...parts)).toLowerCase(),
    );
  }
  assert.equal(read(path.join(value.privateHome, '.gemini', 'antigravity', 'session.json')).account, 'kept');
  assert.equal(fs.lstatSync(path.join(value.privateHome, '.gemini', 'config')).isSymbolicLink(), false);
});

test('unsafe junctions and private file links are refused without changing shared data', { skip: process.platform !== 'win32' }, () => {
  const value = fixture();
  write(value.agentFile, connection());
  fs.mkdirSync(path.join(value.privateHome, '.gemini'), { recursive: true });
  write(path.join(value.privateHome, '.magpie-antigravity-ide', 'native-profile.json'), {
    product: 'magpie-antigravity-ide', version: 1,
  });
  fs.symlinkSync(path.join(value.home, '.gemini', 'config'), path.join(value.privateHome, '.gemini', 'config'), 'junction');
  assert.throws(() => run(value), /unsafe|linked|junction/);

  fs.rmSync(path.join(value.privateHome, '.gemini', 'config'), { recursive: true, force: true });
  fs.mkdirSync(path.join(value.privateHome, '.gemini', 'config'), { recursive: true });
  const outside = path.join(value.root, 'outside.json');
  write(outside, {});
  fs.symlinkSync(outside, files(value).config);
  assert.throws(() => run(value), /regular file|must not be links/);
  assert.deepEqual(read(outside), {});
});

test('an existing unmarked profile is not adopted', () => {
  const value = fixture();
  write(value.agentFile, connection());
  fs.mkdirSync(path.join(value.privateHome, '.gemini', 'config'), { recursive: true });
  const marker = path.join(value.privateHome, '.magpie-antigravity-ide', 'native-profile.json');
  assert.throws(() => run(value), /unmarked/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(files(value).config), false);
});

test('atomic writes clean up their temporary file when replacement fails', () => {
  const value = fixture();
  write(value.agentFile, connection());
  run(value);
  const before = fs.readFileSync(files(value).config, 'utf8');
  fs.rmSync(path.join(value.privateHome, '.antigravity', 'settings.json'));
  fs.mkdirSync(path.join(value.privateHome, '.antigravity', 'settings.json'));
  assert.throws(() => run(value));
  assert.equal(fs.readFileSync(files(value).config, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(files(value).config)).some((name) => name.endsWith('.tmp')), false);
  assert.equal(fs.readdirSync(path.dirname(files(value).settings)).some((name) => name.endsWith('.tmp')), false);
});

test('an existing private projects junction must target a shared or private directory', { skip: process.platform !== 'win32' }, () => {
  const value = fixture();
  write(value.agentFile, connection());
  run(value);
  fs.rmSync(path.join(value.privateHome, '.gemini','config','projects'), { recursive: true, force: true });
  fs.mkdirSync(path.join(value.root, 'outside'), { recursive: true });
  fs.symlinkSync(path.join(value.root, 'outside'), path.join(value.privateHome, '.gemini','config','projects'), 'junction');
  assert.throws(() => run(value), /junction/);
  write(path.join(value.home, '.gemini', 'config', 'config.json'), { projects: {} });
  assert.throws(() => run(value), /junction/);
});

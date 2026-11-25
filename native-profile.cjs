'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const PRODUCT = 'magpie-antigravity-ide';
const MARKER = path.join('.magpie-antigravity-ide', 'native-profile.json');
const CONFIG_KEYS = ['projects', 'plugins', 'sidecars'];

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function absolute(value, name) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  return path.resolve(value);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lstat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function isDirectory(file) {
  return Boolean(fs.statSync(file, { throwIfNoEntry: false })?.isDirectory());
}

function realDirectory(file, label) {
  const stat = lstat(file);
  if (!stat || !stat.isDirectory()) fail(`${label} must be an existing real directory`);
  if (!samePath(fs.realpathSync.native(file), file)) fail(`${label} must not traverse a symlink or junction`);
  return fs.realpathSync.native(file);
}

function safeParent(file, root) {
  let current = root;
  const relative = path.relative(root, path.dirname(file));
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (!stat) fail(`refusing to create through an unknown directory: ${current}`);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe private directory: ${current}`);
    if (!samePath(fs.realpathSync.native(current), current)) fail(`linked private directory: ${current}`);
  }
}

function readJson(file, label, missing) {
  const stat = lstat(file);
  if (!stat) return missing;
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(label + ' is not valid JSON');
  }
  if (!isObject(value)) fail(`${label} must contain a JSON object`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function profilePath(home, privateHome, cli) {
  if (samePath(home, privateHome) || within(privateHome, home)) fail('privateHome must not be or contain home');
  const native = path.join(home, '.antigravity-ide', 'magpie-native', 'hub-home');
  const local = path.join(home, 'AppData', 'Local', 'MagpieAntigravityIDE', 'hub-home');
  const cliPath = cli && path.join(home, 'AppData', 'Local', 'MagpieAntigravityIDE', `cli-${cli}-home`);
  if (cli ? !samePath(privateHome, cliPath) : !samePath(privateHome, native) && !samePath(privateHome, local)) {
    fail('privateHome must be the dedicated hub-home under .antigravity-ide/magpie-native or AppData/Local/MagpieAntigravityIDE');
  }
  if (within(path.join(home, '.gemini'), privateHome) || within(path.join(home, '.antigravity'), privateHome)) {
    fail('privateHome must not be a shared Gemini directory');
  }
}

function validateUserSettings(value) {
  if (!isObject(value)) fail('userSettings must be an object');
  return clone(value);
}

function initialBase(home, privateHome, privateConfigFile) {
  if (lstat(privateConfigFile)) {
    const current = readJson(privateConfigFile, 'private config');
    if (own(current, 'userSettings')) current.userSettings = validateUserSettings(current.userSettings);
    if (own(current, 'plugins') && !isObject(current.plugins)) fail('plugins must be an object');
    return current;
  }
  const source = readJson(path.join(home, '.gemini', 'config', 'config.json'), 'shared config', {});
  const base = {};
  if (own(source, 'userSettings')) base.userSettings = validateUserSettings(source.userSettings);
  if (own(source, 'plugins') && isObject(source.plugins)) base.plugins = clone(source.plugins);
  return base;
}

function modelList(models) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(models) ? models : []) {
    if (!isObject(value) || typeof value.id !== 'string' || !value.id || /[,\x00-\x1f\x7f]/.test(value.id) || seen.has(value.id)) continue;
    const model = {
      modelId: value.id,
      displayName: typeof value.name === 'string' && value.name ? value.name : value.id,
    };
    if (Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0) model.maxTokens = value.maxTokens;
    else if (Number.isSafeInteger(value.context) && value.context > 0) model.maxTokens = value.context;
    if (Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0) model.maxOutputTokens = value.maxOutputTokens;
    else if (Number.isSafeInteger(value.output) && value.output > 0) model.maxOutputTokens = value.output;
    if (typeof value.group === 'string' && value.group) model.group = value.group;
    if (typeof value.supportsImages === 'boolean') model.supportsImages = value.supportsImages;
    else if (typeof value.images === 'boolean') model.supportsImages = value.images;
    seen.add(value.id);
    result.push(model);
  }
  return result;
}

function routeFrom(source) {
  const gateway = isObject(source.gateway) ? source.gateway : {};
  const url = gateway.url ?? source.gatewayUrl;
  const apiKey = gateway.apiKey ?? gateway.key ?? source.gatewayKey;
  if (source.gateway?.enabled === false) return { mode: 'google', selected: null, models: [] };
  if (url == null && apiKey == null && source.selectedModel == null) return { mode: 'google', selected: null, models: [] };
  if (typeof url !== 'string' || !url || typeof apiKey !== 'string' || !apiKey || /[\r\n\0]/.test(apiKey)) {
    fail('Magpie config is incomplete');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('Magpie gateway URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || !['/', '/v1', '/v1/'].includes(parsed.pathname)) {
    fail('Magpie gateway must be a local loopback URL');
  }
  if (typeof source.selectedModel !== 'string' || !source.selectedModel) fail('Magpie config has no selected model');
  const all = modelList(source.models);
  const selected = all.find(({ modelId }) => modelId === source.selectedModel);
  if (!selected) fail('the selected model is not in the visible Magpie model list');
  return {
    mode: 'magpie',
    selected: selected.modelId,
    models: [selected, ...all.filter(({ modelId }) => modelId !== selected.modelId)],
    url: parsed.origin,
    apiKey,
  };
}

function summary(route) {
  const body = route.mode === 'magpie'
    ? { mode: route.mode, selected: route.selected, models: route.models }
    : { mode: route.mode, selected: null, models: [] };
  const ids = route.mode === 'magpie' ? route.models.map(({ modelId }) => modelId) : [];
  return {
    mode: route.mode,
    selected: route.mode === 'magpie' ? route.selected : null,
    ids,
    count: ids.length,
    signature: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

function assertJunction(source, destination, privateHome) {
  const origin = lstat(source);
  const link = lstat(destination);
  if (!origin || !origin.isDirectory() || origin.isSymbolicLink()) fail(`shared link source must be a real directory: ${source}`);
  if (!link?.isSymbolicLink() || !isDirectory(destination)) fail(`junction target must be a junction directory: ${destination}`);
  const realOrigin = fs.realpathSync.native(source);
  const realDestination = fs.realpathSync.native(destination);
  if (!samePath(realOrigin, realDestination) || within(privateHome, realDestination)) {
    fail(`junction does not point at its shared directory: ${destination}`);
  }
  const raw = fs.readlinkSync(destination);
  const target = path.resolve(path.dirname(destination), raw);
  if (!samePath(target, source) && !samePath(target, realOrigin)) fail(`unsafe junction target: ${destination}`);
}

function ensureJunction(source, destination, privateHome) {
  // A fresh agy profile creates its own plugins/projects directories on first
  // launch if there was no corresponding shared directory. Keep those files.
  const existing = lstat(destination);
  if (existing?.isDirectory() && !existing.isSymbolicLink()) {
    if (!within(privateHome, fs.realpathSync.native(destination))) fail('unexpected private directory');
    return;
  }
  if (lstat(destination)) {
    assertJunction(source, destination, privateHome);
    return;
  }
  if (!isDirectory(source) || lstat(source)?.isSymbolicLink()) return;
  fs.symlinkSync(path.resolve(source), destination, 'junction');
  assertJunction(source, destination, privateHome);
}

function ensureLinks(home, privateHome) {
  for(const name of ['bin','antigravity']) ensureJunction(path.join(home,'.gemini',name),path.join(privateHome,'.gemini',name),privateHome);
  for(const name of CONFIG_KEYS) ensureJunction(path.join(home,'.gemini','config',name),path.join(privateHome,'.gemini','config',name),privateHome);
}
function atomicJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, data, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function marker(privateHome) {
  const current = readJson(path.join(privateHome, MARKER), 'private profile marker', null);
  if (current !== null && (current.product !== PRODUCT || current.version !== 1)) {
    fail('private profile marker belongs to another product');
  }
  return current;
}

function createMarker(privateHome) {
  const directory = path.dirname(path.join(privateHome, MARKER));
  if (!lstat(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  atomicJson(path.join(privateHome, MARKER), { product: PRODUCT, version: 1 });
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item)]));
}

function prepare(options = {}) {
  return prepareProfile(options);
}

function prepareCli(options = {}) {
  if (!['google', 'magpie'].includes(options.mode)) fail('CLI mode must be google or magpie');
  return prepareProfile(options, options.mode);
}

function prepareProfile(options, cli) {
  const home = absolute(options.home, 'home');
  const privateHome = absolute(options.privateHome, 'privateHome');
  const agentFile = cli ? null : absolute(options.agentFile, 'agentFile');
  if (options.checkOnly !== undefined && typeof options.checkOnly !== 'boolean') fail('checkOnly must be boolean');
  profilePath(home, privateHome, cli);
  realDirectory(home, 'home');

  // CLI routing comes exclusively from its own session settings. Disable App
  // gateways for both modes; a Magpie CLI session supplies its explicit provider.
  const route = cli ? routeFrom({}) : routeFrom(readJson(agentFile, 'Magpie agent config', {}));
  const output = summary(route);
  if (options.checkOnly) return output;

  let owner = null;
  if (lstat(privateHome)) {
    realDirectory(privateHome, 'privateHome');
    if (!samePath(privateHome, fs.realpathSync.native(privateHome))) fail('privateHome must not be a link');
    owner = marker(privateHome);
    if (owner === null) {
      const profiles = ['.gemini', '.antigravity'];
      if (profiles.every((name) => !lstat(path.join(privateHome, name)))) {
        createMarker(privateHome);
      }
    }
  } else {
    fs.mkdirSync(privateHome, { recursive: true, mode: 0o700 });
    if (!samePath(fs.realpathSync.native(privateHome), privateHome)) fail('privateHome must not traverse a junction');
  }
  if (owner === null && (lstat(path.join(privateHome, '.gemini')) || lstat(path.join(privateHome, '.antigravity')))) {
    fail('refusing to take ownership of an existing unmarked private profile');
  }
  const directories = ['.gemini', '.gemini/config', '.antigravity', '.magpie-antigravity-ide'];
  for (const relative of directories) {
    const directory = path.join(privateHome, relative);
    if (!lstat(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe private directory: ${directory}`);
    if (!samePath(fs.realpathSync.native(directory), directory)) fail(`linked private directory: ${directory}`);
  }

  const configFile = path.join(privateHome, '.gemini', 'config', 'config.json');
  const settingsFile = path.join(privateHome, '.antigravity', 'settings.json');
  safeParent(configFile, privateHome);
  safeParent(settingsFile, privateHome);
  if (lstat(configFile)?.isSymbolicLink() || lstat(settingsFile)?.isSymbolicLink()) fail('private config files must not be links');

  const base = initialBase(home, privateHome, configFile);
  const settings = readJson(settingsFile, 'private settings', {});
  if (route.mode === 'magpie') {
    base.gateway = { enabled: true, url: route.url, apiKey: route.apiKey, wireProtocol: 'openai' };
    base.models = { defaultModelId: route.selected, list: route.models };
    settings.gateway = { enabled: true, url: route.url, apiKey: route.apiKey, wireProtocol: 'openai' };
    settings.models = { defaultModelId: route.selected, list: route.models };
  } else {
    base.gateway = { enabled: false };
    base.models = {};
    settings.gateway = { enabled: false };
    settings.models = {};
  }

  if (owner === null) {
    createMarker(privateHome);
  }
  ensureLinks(home, privateHome);
  atomicJson(configFile, base);
  atomicJson(settingsFile, stripUndefined(settings));

  if (cli) {
    const cliDir = path.join(privateHome, '.gemini', 'antigravity-cli');
    if (!lstat(cliDir)) fs.mkdirSync(cliDir, { mode: 0o700 });
    realDirectory(cliDir, 'private CLI directory');
    const cliFile = path.join(cliDir, 'settings.json');
    const cliSettings = readJson(cliFile, 'private CLI settings', {});
    // A previous terminal may have saved its selected provider/model. Each new
    // explicit session must return to its requested source without moving tokens.
    for (const key of ['modelProvider', 'model', 'customModelsConfig', 'gateway', 'models']) delete cliSettings[key];
    atomicJson(cliFile, cliSettings);
  }

  return output;
}

module.exports = { prepare, prepareCli };

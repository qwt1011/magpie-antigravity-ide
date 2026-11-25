'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {prepareCli} = require('./native-profile.cjs');

function session({mode, home, localData, env = {}, magpie}) {
  if (!['google', 'magpie'].includes(mode)) throw Error('CLI source must be google or magpie.');
  const privateHome = path.join(localData, 'MagpieAntigravityIDE', 'cli-' + mode + '-home');
  const args = [];
  const childEnv = {};
  // VS Code terminal env uses null to remove inherited credentials.
  for (const name of Object.keys(env)) if (/^(AGY_LLM_GATEWAY_|GEMINI_|GOOGLE_GEMINI_|GOOGLE_API_KEY$|MAGPIE_IDE_)/i.test(name)) childEnv[name] = null;
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL']) childEnv[name] = null;
  if (mode === 'magpie') {
    if (!magpie?.model || typeof magpie.model !== 'string' || /[\x00-\x1f\x7f]/.test(magpie.model) ||
        typeof magpie.GEMINI_API_KEY !== 'string' || !magpie.GEMINI_API_KEY || /[\r\n\0]/.test(magpie.GEMINI_API_KEY)) throw Error('请先在 Magpie 的 Antigravity CLI 条目连接模型。');
    let url; try {url = new URL(magpie.GOOGLE_GEMINI_BASE_URL);} catch {throw Error('Magpie CLI 网关地址无效。');}
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw Error('Magpie CLI 只支持本机网关。');
    if (typeof magpie.settings !== 'string' || !path.isAbsolute(magpie.settings) || !fs.statSync(magpie.settings, {throwIfNoEntry:false})?.isFile()) throw Error('找不到 Magpie CLI 会话配置。请在 Magpie 重新连接 Antigravity CLI。');
    args.push('--settings', magpie.settings, '--model', magpie.model);
    childEnv.GEMINI_API_KEY = magpie.GEMINI_API_KEY;
    childEnv.GOOGLE_GEMINI_BASE_URL = magpie.GOOGLE_GEMINI_BASE_URL;
  }
  prepareCli({home, privateHome, mode});
  Object.assign(childEnv, {HOME:privateHome, USERPROFILE:privateHome, NO_PROXY:[env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',')});
  return {args, env:childEnv};
}
module.exports = {session};

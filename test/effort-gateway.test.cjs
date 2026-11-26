'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start } = require('../effort-gateway.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, base);
    const req = http.request(target, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function control(base, token, origin, body) {
  return request(base, '/control', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function fixture(t, onRequest) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const item = { req, body: Buffer.concat(chunks), url: req.url };
      received.push(item);
      onRequest(item, res);
    });
  });
  const upstreamPort = await listen(upstream);
  const allowedOrigin = 'http://127.0.0.1:39217';
  const gateway = await start({
    url: `http://127.0.0.1:${upstreamPort}/v1`,
    key: 'upstream-secret',
    models: [
      { id: 'model/a', efforts: ['low', 'high'] },
      { id: 'model/b', efforts: ['low', 'high'] },
    ],
    allowedOrigin,
  });
  t.after(async () => {
    await gateway.close();
    await close(upstream);
  });
  return { gateway, upstream, received, allowedOrigin, key: 'upstream-secret' };
}

function chat(base, token, body, headers = {}) {
  return request(base, '/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

test('forwards exact request bytes without a selected effort', async (t) => {
  const { gateway, received, allowedOrigin, key } = await fixture(t, (_item, res) => {
    res.writeHead(201, { 'x-upstream': 'yes' });
    res.end('accepted');
  });
  const body = Buffer.from('{\n  "model": "model/a",\n  "messages": [{"role": "user", "content": "hi"}]\n}');
  const result = await chat(gateway.url, key, body);
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-upstream'], 'yes');
  assert.equal(result.body.toString(), 'accepted');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/v1/chat/completions');
  assert.deepEqual(received[0].body, body);
  assert.equal(received[0].req.headers.authorization, 'Bearer upstream-secret');
  assert.equal(received[0].req.headers.origin, undefined);

  const controlResult = await request(gateway.url, '/control', {
    headers: { origin: allowedOrigin, authorization: `Bearer ${gateway.token}` },
  });
  assert.equal(controlResult.status, 200);
  assert.deepEqual(JSON.parse(controlResult.body), {
    choices: { 'model/a': ['low', 'high'], 'model/b': ['low', 'high'] },
    selected: {},
  });
});

test('applies live effort by model and preserves other fields', async (t) => {
  const { gateway, received, allowedOrigin, key } = await fixture(t, (_item, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await control(gateway.url, gateway.token, allowedOrigin, { model: 'model/a', effort: 'low' });
  await chat(gateway.url, key, JSON.stringify({
    model: 'model/a',
    thinking: { keep: true },
    reasoning: { effort: 'medium', extra: 1 },
  }));
  const low = JSON.parse(received.at(-1).body);
  assert.equal(low.reasoning_effort, 'low');
  assert.equal(low.reasoning.effort, 'low');
  assert.equal(low.reasoning.extra, 1);
  assert.deepEqual(low.thinking, { keep: true });

  await control(gateway.url, gateway.token, allowedOrigin, { model: 'model/a', effort: 'high' });
  await chat(gateway.url, key, JSON.stringify({ model: 'model/a' }));
  assert.equal(JSON.parse(received.at(-1).body).reasoning_effort, 'high');

  await chat(gateway.url, key, Buffer.from('{"model":"model/a"}'));
  assert.equal(JSON.parse(received.at(-1).body).reasoning_effort, 'high');

  await control(gateway.url, gateway.token, allowedOrigin, { model: 'model/b', effort: 'low' });
  await chat(gateway.url, key, JSON.stringify({ model: 'model/b' }));
  assert.equal(JSON.parse(received.at(-1).body).reasoning_effort, 'low');

  await control(gateway.url, gateway.token, allowedOrigin, { model: 'model/b', effort: null });
  const exact = Buffer.from('{"model":"model/b","reasoning_effort":"medium"}');
  await chat(gateway.url, key, exact);
  assert.deepEqual(received.at(-1).body, exact);
});

test('rejects unsupported models, malformed JSON and arbitrary paths', async (t) => {
  const { gateway, received, allowedOrigin, key } = await fixture(t, (_item, res) => res.end());
  const unknown = await chat(gateway.url, key, '{"model":"other"}');
  assert.equal(unknown.status, 404);
  assert.equal(received.length, 0);
  assert.equal((await chat(gateway.url, key, '{')).status, 400);

  await control(gateway.url, gateway.token, allowedOrigin, { model: 'model/a', effort: 'high' });
  const missing = await chat(gateway.url, key, '{}');
  assert.equal(missing.status, 404);

  const arbitrary = await request(gateway.url, '/v1/foo', {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(arbitrary.status, 404);

  const models = await request(gateway.url, '/models', {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(models.status, 200);
  assert.equal(received.at(-1).url, '/v1/models');
});

test('separates control and agent tokens and enforces exact browser origin', async (t) => {
  const { gateway, allowedOrigin, key } = await fixture(t, (_item, res) => res.end());
  const noOrigin = await request(gateway.url, '/control');
  assert.equal(noOrigin.status, 403);

  const wrongOrigin = await request(gateway.url, '/control', {
    headers: { origin: 'http://localhost:39217', authorization: `Bearer ${gateway.token}` },
  });
  assert.equal(wrongOrigin.status, 403);

  const wrongToken = await request(gateway.url, '/control', {
    headers: { origin: allowedOrigin, authorization: 'Bearer wrong' },
  });
  assert.equal(wrongToken.status, 401);

  const browserAgent = await request(gateway.url, '/v1/models', {
    headers: { origin: allowedOrigin, authorization: `Bearer ${key}` },
  });
  assert.equal(browserAgent.status, 403);

  const controlTokenOnAgent = await request(gateway.url, '/v1/models', {
    headers: { authorization: `Bearer ${gateway.token}` },
  });
  assert.equal(controlTokenOnAgent.status, 401);

  const agentKeyOnControl = await request(gateway.url, '/control', {
    headers: { origin: allowedOrigin, authorization: `Bearer ${key}` },
  });
  assert.equal(agentKeyOnControl.status, 401);

  const options = await request(gateway.url, '/control', {
    method: 'OPTIONS',
    headers: {
      origin: allowedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-origin'], allowedOrigin);
  assert.equal(options.headers['access-control-allow-headers'], 'Authorization, Content-Type');

  const preflightWrong = await request(gateway.url, '/control', {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:1' },
  });
  assert.equal(preflightWrong.status, 403);
});

test('forwards upstream errors and streams SSE before normal completion', async (t) => {
  const { gateway, key } = await fixture(t, (_item, res) => {
    if (res.req.url === '/v1/models') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate"}');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    res.write('data: first\n\n');
    setTimeout(() => res.end('data: done\n\n'), 20);
  });
  const models = await request(gateway.url, '/v1/models', {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(models.status, 429);
  assert.equal(models.body.toString(), '{"error":"rate"}');

  const response = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/v1/chat/completions', gateway.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    }, resolve);
    req.on('error', reject);
    req.end('{"model":"model/a"}');
  });
  let text = '';
  for await (const chunk of response) {
    text += chunk;
    if (text.includes('data: first')) break;
  }
  assert.equal(text, 'data: first\n\n');
});

test('propagates client cancellation to upstream', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const { gateway, key } = await fixture(t, (item, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: waiting\n\n');
    res.once('close', upstreamClosed);
  });
  const req = http.request(new URL('/v1/chat/completions', gateway.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  });
  await new Promise((resolve) => {
    req.once('response', (res) => {
      res.once('data', resolve);
    });
    req.end('{"model":"model/a"}');
  });
  req.destroy();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 1000)),
  ]);
});

test('supports declared extended levels and leaves models without levels on defaults', async (t) => {
  const received=[];
  const upstream=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{received.push(JSON.parse(body));res.end('{}');});});
  const port=await listen(upstream),origin='http://127.0.0.1:39217';
  const gateway=await start({url:'http://127.0.0.1:'+port+'/v1/',key:'fixture-key',allowedOrigin:origin,models:[{id:'extended',efforts:['none','minimal','xhigh','max','ultra']},{id:'plain',efforts:[]}]});
  t.after(async()=>{await gateway.close();await close(upstream);});
  for(const effort of ['none','minimal','xhigh','max','ultra']){
    assert.equal((await control(gateway.url,gateway.token,origin,{model:'extended',effort})).status,200);
    await chat(gateway.url,'fixture-key','{"model":"extended"}');assert.equal(received.at(-1).reasoning_effort,effort);
  }
  await chat(gateway.url,'fixture-key','{"model":"plain","reasoning_effort":"medium"}');assert.equal(received.at(-1).reasoning_effort,'medium');
  assert.equal((await control(gateway.url,gateway.token,origin,{model:'plain',effort:'high'})).status,400);
  assert.equal((await chat(gateway.url,'é'.repeat(11),'{"model":"plain"}')).status,401);
});

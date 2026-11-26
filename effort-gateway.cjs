'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const MAX_BODY = 32 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function normalizeGatewayUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('Invalid upstream URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname.startsWith('[') && !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !['/', '/v1', '/v1/'].includes(parsed.pathname)
  ) {
    fail('Invalid upstream URL');
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: parsed.port || undefined,
    origin: parsed.origin,
  };
}

function normalizeAllowedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('Invalid allowed origin');
  }
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    fail('Invalid allowed origin');
  }
  return parsed.origin;
}

function normalizeModels(value) {
  if (!Array.isArray(value) || value.length === 0) fail('Invalid models');
  const models = new Map();
  for (const model of value) {
    if (
      !model ||
      typeof model.id !== 'string' ||
      model.id.length === 0 ||
      models.has(model.id) ||
      !Array.isArray(model.efforts) ||
      model.efforts.some((effort) => !EFFORTS.has(effort))
    ) {
      fail('Invalid models');
    }
    models.set(model.id, new Set(model.efforts));
  }
  return models;
}

function tokenBytes(token) {
  return Buffer.from(token, 'utf8');
}

function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  const expected = token;
  return (
    Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
    timingSafeEqual(tokenBytes(supplied), tokenBytes(expected))
  );
}

function fixedError(response, statusCode, message) {
  const body = Buffer.from(JSON.stringify({ error: message }));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function controlHeaders(origin, methods) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': methods,
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function requestUrl(request) {
  try {
    return new URL(request.url, 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > limit) {
        finish(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail('Invalid JSON');
        }
        finish(null, parsed);
      } catch (error) {
        finish(error);
      }
    });
    request.on('error', finish);
    request.on('aborted', () => finish(Object.assign(new Error('Request aborted'), { statusCode: 400 })));
  });
}

function filteredHeaders(headers, { authorization, contentLength } = {}) {
  const result = { ...headers };
  const connectionTokens = String(headers.connection || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...connectionTokens]) delete result[name];
  delete result.host;
  if (authorization === null) delete result.authorization;
  else if (authorization !== undefined) result.authorization = authorization;
  if (contentLength !== undefined) result['content-length'] = String(contentLength);
  return result;
}

function parseAndPrepare(body, selected, efforts) {
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    fail('Malformed JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid JSON');
  if (typeof value.model !== 'string' || !efforts.has(value.model)) {
    fail('Unknown model', 404);
  }
  const effort = selected.get(value.model);
  if (!effort) return { body, model: value.model };
  value.reasoning_effort = effort;
  if (value.reasoning && typeof value.reasoning === 'object' && !Array.isArray(value.reasoning)) {
    value.reasoning.effort = effort;
  }
  return { body: Buffer.from(JSON.stringify(value)), model: value.model };
}

async function start({ url, key, models, allowedOrigin } = {}) {
  const upstream = normalizeGatewayUrl(url);
  const modelEfforts = normalizeModels(models);
  const origin = normalizeAllowedOrigin(allowedOrigin);
  if (typeof key !== 'string' || key.length === 0) fail('Invalid upstream key');

  const token = randomBytes(32).toString('hex');
  const selected = new Map();
  const agentSockets = new Set();
  const aborters = new Set();
  const pending = new Set();

  const server = http.createServer(async (request, response) => {
    const current = requestUrl(request);
    if (!current) {
      fixedError(response, 404, 'Not found');
      return;
    }

    if (current.pathname === '/control') {
      if (request.headers.origin !== origin) {
        fixedError(response, 403, 'Origin forbidden');
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, controlHeaders(origin, 'GET, POST, OPTIONS'));
        response.end();
        return;
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        fixedError(response, 401, 'Unauthorized');
        return;
      }
      if (current.search || !['GET', 'POST'].includes(request.method)) {
        fixedError(response, 404, 'Not found');
        return;
      }
      if (request.method === 'GET') {
        const payload = {
          choices: Object.fromEntries(
            [...modelEfforts].map(([id, efforts]) => [id, [...efforts]])
          ),
          selected: Object.fromEntries(selected),
        };
        const body = Buffer.from(JSON.stringify(payload));
        response.writeHead(200, {
          ...controlHeaders(origin, 'GET, POST, OPTIONS'),
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        response.end(body);
        return;
      }
      try {
        const payload = await readJson(request, 1024 * 1024);
        const keys = Object.keys(payload);
        if (
          keys.length !== 2 ||
          !keys.includes('model') ||
          !keys.includes('effort') ||
          typeof payload.model !== 'string'
        ) {
          fail('Invalid control');
        }
        const efforts = modelEfforts.get(payload.model);
        if (!efforts) fail('Unknown model', 404);
        if (payload.effort === null) selected.delete(payload.model);
        else if (typeof payload.effort === 'string' && efforts.has(payload.effort)) {
          selected.set(payload.model, payload.effort);
        } else {
          fail('Invalid effort');
        }
        const body = Buffer.from(JSON.stringify({
          choices: Object.fromEntries(
            [...modelEfforts].map(([id, values]) => [id, [...values]])
          ),
          selected: Object.fromEntries(selected),
        }));
        response.writeHead(200, {
          ...controlHeaders(origin, 'GET, POST, OPTIONS'),
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch (error) {
        fixedError(response, error.statusCode || 400, error.statusCode === 404 ? 'Unknown model' : 'Invalid control');
      }
      return;
    }

    const route =
      current.pathname === '/v1/chat/completions' && request.method === 'POST'
        ? '/v1/chat/completions'
        : (current.pathname === '/v1/models' && request.method === 'GET') ||
          (current.pathname === '/models' && request.method === 'GET')
        ? '/v1/models'
        : null;
    if (!route || current.search) {
      fixedError(response, 404, 'Not found');
      return;
    }
    if (!tokenMatches(request.headers.authorization, key)) {
      fixedError(response, 401, 'Unauthorized');
      return;
    }
    if (request.headers.origin !== undefined) {
      fixedError(response, 403, 'Origin forbidden');
      return;
    }

    let body;
    let model;
    if (route === '/v1/chat/completions') {
      const declared = request.headers['content-length'];
      if (declared !== undefined && Number(declared) > MAX_BODY) {
        fixedError(response, 413, 'Request too large');
        return;
      }
      try {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          let length = 0;
          request.on('data', (chunk) => {
            length += chunk.length;
            if (length > MAX_BODY) {
              reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
            } else {
              chunks.push(chunk);
            }
          });
          request.on('end', () => {
            if (length <= MAX_BODY) resolve(Buffer.concat(chunks));
          });
          request.on('error', reject);
          request.on('aborted', () => reject(Object.assign(new Error('Request aborted'), { statusCode: 400 })));
        });
        ({ body, model } = parseAndPrepare(body, selected, modelEfforts));
      } catch (error) {
        fixedError(response, error.statusCode || 400, error.statusCode === 413 ? 'Request too large' : error.statusCode === 404 ? 'Unknown model' : 'Malformed JSON');
        return;
      }
    }

    const target = `${upstream.origin}${route}`;
    const transport = upstream.protocol === 'https:' ? https : http;
    const headers = filteredHeaders(request.headers, {
      authorization: `Bearer ${key}`,
      contentLength: body ? body.length : undefined,
    });
    const upstreamRequest = transport.request(target, {
      method: request.method,
      headers,
    });
    let aborted = false;
    const cancel = () => {
      if (aborted) return;
      aborted = true;
      upstreamRequest.destroy();
    };
    aborters.add(cancel);
    pending.add(upstreamRequest);
    request.once('aborted', cancel);
    response.once('close', () => {
      if (!response.writableFinished) cancel();
    });

    upstreamRequest.on('response', (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        filteredHeaders(upstreamResponse.headers)
      );
      upstreamResponse.pipe(response);
      upstreamResponse.once('aborted', () => response.destroy());
      upstreamResponse.once('error', () => response.destroy());
    });
    upstreamRequest.on('error', () => {
      if (response.headersSent) response.destroy();
      else fixedError(response, 502, 'Upstream unavailable');
    });
    upstreamRequest.once('close', () => {
      pending.delete(upstreamRequest);
      aborters.delete(cancel);
    });
    upstreamRequest.end(body);
  });

  server.on('connection', (socket) => {
    agentSockets.add(socket);
    socket.once('close', () => agentSockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const closed = new Promise((resolve) => server.once('close', resolve));
  const close = async () => {
    if (server.listening) {
      server.close();
      for (const cancel of [...aborters]) cancel();
      for (const socket of agentSockets) socket.destroy();
    }
    await closed;
  };

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close,
  };
}

module.exports = { start };

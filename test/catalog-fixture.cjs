'use strict';

const http = require('node:http');

const MODELS = Object.freeze([
  {
    id: 'catalog/alpha',
    displayName: 'Alpha',
    maxTokens: 4096,
    maxOutputTokens: 512,
  },
  {
    id: 'catalog/beta',
    displayName: 'Beta',
    maxTokens: 8192,
    maxOutputTokens: 1024,
  },
]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, status, message, code = 'fixture_error') {
  sendJson(response, status, {
    error: { message, type: 'invalid_request_error', code },
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        fail(new Error('request body exceeds 1 MiB'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    request.on('aborted', () => fail(new Error('request aborted')));
    request.on('error', fail);
  });
}

function completionFor(model) {
  return model === MODELS[0].id ? 'alpha reply' : 'beta reply';
}

function sendCompletion(response, model, stream) {
  const content = completionFor(model);
  const id = model === MODELS[0].id ? 'chatcmpl-alpha' : 'chatcmpl-beta';
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    sendJson(response, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const event = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const base = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
  };
  event({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  event({
    ...base,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  event({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  response.end('data: [DONE]\n\n');
}

function catalogList(hiddenModels) {
  return MODELS
    .filter(({ id }) => !hiddenModels.has(id))
    .map(({ id, displayName, maxTokens, maxOutputTokens }) => ({
      modelId: id,
      displayName,
      maxTokens,
      maxOutputTokens,
    }));
}

function openAIModelList(hiddenModels) {
  return {
    object: 'list',
    data: MODELS
      .filter(({ id }) => !hiddenModels.has(id))
      .map(({ id, displayName }) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: displayName,
      })),
  };
}

function normalizeHiddenModels(input = []) {
  if (!Array.isArray(input)) {
    throw new TypeError('hiddenModels must be an array of model ids');
  }
  const known = new Set(MODELS.map(({ id }) => id));
  const hidden = new Set(input);
  for (const id of hidden) {
    if (!known.has(id)) throw new TypeError(`unknown fixture model: ${id}`);
  }
  return hidden;
}

async function startFixture(options = {}) {
  const receivedModels = []; const paths=[];
  const hiddenModels = normalizeHiddenModels(options.hiddenModels);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');

    paths.push(request.method+' '+url.pathname); if (request.method === 'GET' && url.pathname === '/v1/models') {
      const value = url.searchParams.get('format') === 'antigravity'
        ? { list: catalogList(hiddenModels) }
        : openAIModelList(hiddenModels);
      sendJson(response, 200, value);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (!response.destroyed) {
          sendError(response, 400, error.message, 'invalid_body');
        }
        return;
      }
      if (!body || typeof body.model !== 'string') {
        sendError(response, 400, 'body.model must be a string');
        return;
      }

      receivedModels.push(body.model);
      if (!MODELS.some(({ id }) => id === body.model)) {
        sendError(response, 404, `unknown fixture model: ${body.model}`, 'model_not_found');
        return;
      }
      sendCompletion(response, body.model, body.stream === true);
      return;
    }

    sendError(response, 404, 'not found', 'not_found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  if (!Number.isInteger(port) || port < 1) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('fixture did not bind a loopback port');
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    paths,baseUrl,
    url: baseUrl,
    models: MODELS.map((model) => ({ ...model })),
    receivedModels,
    setHiddenModels(ids) {
      const next = normalizeHiddenModels(ids);
      hiddenModels.clear();
      for (const id of next) hiddenModels.add(id);
    },
    close() {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

module.exports = { startFixture };

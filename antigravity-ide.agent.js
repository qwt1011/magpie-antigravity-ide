// Antigravity IDE as a Magpie agent.
//
// Magpie owns this file alone; Antigravity reads it when a new IDE process
// starts. selectedModel is the original Magpie model id. A temporary IDE-side
// choice stays in the IDE and is never copied back into Magpie's selection.
export const agent = {
  id: "antigravity-ide",
  name: "Antigravity IDE",
  dir: "~/.antigravity-ide",
  config: "~/.antigravity-ide/magpie-ide.json",
  format: "json",
  model: "selectedModel",
  notice:
    "Windows IDE 2.7.0 only: complete the repository's local setup, then use start-native.cmd. Reload the IDE window after connection or model-list changes.",
};

function cleanModel(model) {
  if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id) {
    return undefined;
  }
  const out = {
    id: model.id,
    name: typeof model.name === "string" && model.name ? model.name : model.id,
  };
  for (const field of ["context", "output"]) if (Number.isSafeInteger(model[field]) && model[field] > 0) out[field] = model[field];
  if (typeof model.images === "boolean") out.images = model.images;
  return out;
}

export function modelsOf(models) {
  const seen = new Set();
  const out = [];
  for (const model of models || []) {
    const entry = cleanModel(model);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export function connect({ gateway, model, models } = {}) {
  if (!gateway || typeof gateway.url !== "string" || !gateway.url) {
    throw new TypeError("connect needs the Magpie gateway URL");
  }
  if (typeof gateway.key !== "string" || !gateway.key) {
    throw new TypeError("connect needs the Magpie-issued gateway key");
  }
  if (!model || typeof model.id !== "string" || !model.id) {
    throw new TypeError("connect needs the Magpie-selected model");
  }
  return {
    selectedModel: model.id,
    models: modelsOf(models),
    gatewayUrl: gateway.url,
    gatewayKey: gateway.key,
  };
}

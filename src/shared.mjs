export const DEFAULTS = /* @__PURE__ */ Object.freeze({ provider: 'jev', apiBase: 'https://api.typesafe.ai/v1', model: 'jev-latest', localBase: 'http://127.0.0.1:8742/v1', localModel: 'laya', openaiBase: 'https://api.openai.com/v1', openaiModel: '', openaiMode: 'tools', openaiModels: [], strategyMode: 'choices', hotkey: 'Alt+Shift+J', autoCamera: true, showOverlay: true, maxDecisions: 2000, objective: '', autoReport: true, allowedHosts: [], language:'zh-CN' });
export const PROVIDERS = /* @__PURE__ */ Object.freeze({ jev: { id: 'jev', name: 'Jev', requiresKey: true }, local: { id: 'local', name: 'Laya', requiresKey: false }, openai: { id: 'openai', name: 'OpenAI', requiresKey: true } });
export const strategyMode = value => value === 'commander' ? 'commander' : 'choices';
export const providerId = value => value === 'local' || value === 'openai' ? value : 'jev';
// Which stored fields each provider uses. The popup, validation and background all read this.
export const PROVIDER_FIELDS = /* @__PURE__ */ Object.freeze({ jev: { base: 'apiBase', key: 'apiKey', model: 'model' }, local: { base: 'localBase', key: 'localKey', model: 'localModel' }, openai: { base: 'openaiBase', key: 'openaiKey', model: 'openaiModel' } });
const JEV_MODEL = /^[\w.\/-]{1,80}$/, OPENAI_MODEL = /^[\w.\/:@+-]{1,160}$/;
// The active provider decides which stored endpoint, key and model the background uses.
// kind: whether requests leave for a hosted service ("cloud") or stay on this machine / LAN ("local").
export function activeProvider(s) {
  const id = providerId(s?.provider), p = PROVIDERS[id], f = PROVIDER_FIELDS[id];
  const apiBase = String(s?.[f.base] ?? DEFAULTS[f.base]).trim(), apiKey = String(s?.[f.key] ?? '').trim(), model = String(s?.[f.model] ?? DEFAULTS[f.model]).trim();
  let host = ''; try { host = new URL(apiBase).hostname; } catch {}
  // Commander mode needs a chat model that reasons over a long brief; Jev and Laya always answer choice questions.
  if (id === 'openai') return { ...p, apiBase, apiKey, model, mode: s?.openaiMode === 'json' ? 'json' : 'tools', strategy: strategyMode(s?.strategyMode), requiresKey: !privateHost(host), kind: privateHost(host) ? 'local' : 'cloud' };
  return { ...p, apiBase, apiKey, model, strategy: 'choices', kind: id === 'local' ? 'local' : 'cloud' };
}
export const GAME_HOSTS = ['ra2web.github.io', 'staging.wangerhuoda.com', 'wangerhuoda.com', 'www.wangerhuoda.com'];
export const CHANNEL = 'werhd-jev-extension-v1';
export function supportedGame(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && GAME_HOSTS.includes(u.hostname) || u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname); } catch { return false; }
}
// Any reachable address may be configured; access is requested for exactly that origin. This
// classifier only decides whether plain HTTP deserves a warning: traffic to this machine, private
// LAN ranges, link-local, Tailscale (100.64/10, *.ts.net), private IPv6, private-network suffixes
// and single-label hostnames never crosses the public internet.
export function privateHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(h) || /^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return /^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  if (/\.(local|lan|home|internal|intranet|localdomain|home\.arpa|ts\.net)$/.test(h)) return true;
  return /^[a-z0-9-]+$/.test(h);
}
export function apiEndpoint(value) {
  let u; try { u = new URL(value.trim()); } catch { throw new Error('请输入有效的 API 地址。'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('API 地址不能包含账号、查询参数或片段。');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('API 地址须以 http:// 或 https:// 开头。');
  // Built as a string: a bare host's path "/" trimmed to "" would be reset to "/" by the URL object.
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = path.endsWith('/systemone') ? path : `${path}/systemone`;
  return u.href;
}
// An OpenAI-style service path under the configured base; a pasted full endpoint is trimmed back to the base.
export function serviceUrl(value, path) {
  const u = new URL(apiEndpoint(value));
  u.pathname = u.pathname.replace(/\/systemone$/, '').replace(/\/(chat\/completions|models)$/, '') + path;
  return u.href;
}
// Where decisions go for the given provider.
export const providerEndpoint = p => p.id === 'openai' ? serviceUrl(p.apiBase, '/chat/completions') : apiEndpoint(p.apiBase);
// True when the key would travel in clear text over a network that may be public.
export const plaintextPublic = value => { try { const u = new URL(apiEndpoint(value)); return u.protocol === 'http:' && !privateHost(u.hostname); } catch { return false; } };
// Hosts the user explicitly allowed beyond this machine and private networks: one hostname or IP per entry.
export function normalizeHost(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) throw new Error('请输入地址。');
  let u; try { u = new URL(/^[a-z]+:\/\//.test(text) ? text : `http://${text}`); } catch { throw new Error('请输入有效的地址。'); }
  if (!u.hostname || u.username || u.password) throw new Error('请输入有效的地址。');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Browsers percent-encode junk into a "valid" host; only real hostnames, IPv4 or IPv6 pass.
  const named = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host), v6 = /^[0-9a-f:.]+$/.test(host) && host.includes(':');
  if (!named && !v6) throw new Error('请输入有效的地址。');
  return host;
}
export const sanitizeAllowedHosts = list => [...new Set((Array.isArray(list) ? list : []).map(h => { try { return normalizeHost(h); } catch { return ''; } }).filter(Boolean))].slice(0, 32);
// Plain HTTP to a public address is used only when that host was allowed by hand; HTTPS and private networks need nothing.
export function hostAllowed(value, allowedHosts = []) {
  let u; try { u = new URL(apiEndpoint(value)); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return u.protocol === 'https:' || privateHost(host) || sanitizeAllowedHosts(allowedHosts).includes(host);
}
export const originPattern = value => { const u = new URL(apiEndpoint(value)); return `${u.protocol}//${u.hostname}/*`; };
export function normalizeHotkey(value) {
  const parts = String(value).split('+').map(s => s.trim());
  const key = parts.pop()?.toUpperCase();
  const mods = ['Ctrl','Alt','Shift','Meta'].filter(m => parts.some(p => p.toLowerCase() === m.toLowerCase()));
  if (!/^[A-Z0-9]$|^F(?:[1-9]|1[0-2])$/.test(key ?? '') || !mods.some(m=>m !== 'Shift') || mods.length !== new Set(parts.map(p=>p.toLowerCase())).size) throw new Error('快捷键需要 Ctrl、Alt 或 Meta 加一个字母、数字或 F1–F12。');
  return [...mods, key].join('+');
}
export function hotkeyFromEvent(e) {
  const key = /^(Key|Digit)/.test(e.code) ? e.code.replace(/^(Key|Digit)/,'') : e.code;
  try { return normalizeHotkey([e.ctrlKey&&'Ctrl',e.altKey&&'Alt',e.shiftKey&&'Shift',e.metaKey&&'Meta',key].filter(Boolean).join('+')); } catch { return ''; }
}
export function validateSettings(input, prior = {}) {
  const s = {...DEFAULTS, ...prior, ...input};
  s.provider = providerId(s.provider);
  s.apiBase = String(s.apiBase).trim(); apiEndpoint(s.apiBase);
  s.localBase = String(s.localBase ?? DEFAULTS.localBase).trim(); apiEndpoint(s.localBase);
  s.openaiBase = String(s.openaiBase ?? DEFAULTS.openaiBase).trim(); apiEndpoint(s.openaiBase);
  s.allowedHosts = sanitizeAllowedHosts(s.allowedHosts);
  if (!hostAllowed(s[PROVIDER_FIELDS[s.provider].base], s.allowedHosts)) throw new Error('公网明文地址需要先加入「允许的外部地址」。');
  s.model = String(s.model).trim();
  s.localModel = String(s.localModel ?? DEFAULTS.localModel).trim();
  s.openaiModel = String(s.openaiModel ?? '').trim();
  if (!JEV_MODEL.test(s.model) || !JEV_MODEL.test(s.localModel) || (s.openaiModel && !OPENAI_MODEL.test(s.openaiModel))) throw new Error('模型名称无效。');
  s.openaiMode = s.openaiMode === 'json' ? 'json' : 'tools';
  s.strategyMode = strategyMode(s.strategyMode);
  s.openaiModels = (Array.isArray(s.openaiModels) ? s.openaiModels : []).filter(id => typeof id === 'string' && OPENAI_MODEL.test(id)).slice(0, 500);
  s.hotkey = normalizeHotkey(s.hotkey);
  s.maxDecisions = Number(s.maxDecisions);
  if (!Number.isInteger(s.maxDecisions) || s.maxDecisions < 1 || s.maxDecisions > 10000) throw new Error('每局决策上限应为 1–10000。');
  s.autoCamera = Boolean(s.autoCamera);
  s.showOverlay = Boolean(s.showOverlay);
  s.autoReport = s.autoReport !== false && s.autoReport !== 'false';
  s.language = s.language === 'en' ? 'en' : 'zh-CN';
  s.objective = String(s.objective ?? '').replace(/\s+/g, ' ').trim();
  if (s.objective.length > 300) throw new Error('本局目标最多 300 个字符。');
  s.apiKey = String(s.apiKey ?? '').trim();
  s.localKey = String(s.localKey ?? '').trim();
  s.openaiKey = String(s.openaiKey ?? '').trim();
  if ([s.apiKey, s.localKey, s.openaiKey].some(k => k.length > 4096 || /[\r\n]/.test(k))) throw new Error('密钥格式无效。');
  return s;
}
// Per-field validation for inline form errors. Same rules as validateSettings, but every field
// is checked independently so each message can sit under its own input.
export function fieldErrors(input, {requireKey = false} = {}) {
  const errors = {}, id = providerId(input.provider), f = PROVIDER_FIELDS[id];
  const check = (field, fn) => { try { fn(); } catch (e) { errors[field] = e.message; } };
  const base = String(input[f.base] ?? '');
  check(f.base, () => { apiEndpoint(base); if (!hostAllowed(base, input.allowedHosts)) throw new Error('公网明文地址需要先加入「允许的外部地址」。'); });
  const model = String(input[f.model] ?? '').trim();
  if (id === 'openai' ? model && !OPENAI_MODEL.test(model) : !JEV_MODEL.test(model)) errors[f.model] = '模型名称无效。';
  check('hotkey', () => normalizeHotkey(input.hotkey ?? ''));
  const n = Number(input.maxDecisions);
  if (!Number.isInteger(n) || n < 1 || n > 10000) errors.maxDecisions = '每局决策上限应为 1–10000。';
  if (String(input.objective ?? '').replace(/\s+/g, ' ').trim().length > 300) errors.objective = '本局目标最多 300 个字符。';
  const key = String(input[f.key] ?? '').trim();
  if (key.length > 4096 || /[\r\n]/.test(key)) errors[f.key] = '密钥格式无效。';
  else if (requireKey && !key && id === 'jev') errors.apiKey = '请输入 JEV 密钥。';
  else if (requireKey && !key && id === 'openai' && activeProvider(input).requiresKey) errors.openaiKey = '请输入 API 密钥。';
  return errors;
}
// Which field a background error belongs to, so the popup can show it inline.
export function errorField(message, provider = 'jev') {
  const f = PROVIDER_FIELDS[providerId(provider)];
  if (/JEV 密钥/.test(message)) return 'apiKey';
  if (/API 密钥|更换 API 服务|密钥格式|拒绝了密钥/.test(message)) return f.key;
  if (/授权|访问权限/.test(message)) return '';
  if (/API 地址|允许的外部地址/.test(message)) return f.base;
  if (/模型名称|选择模型|模型列表/.test(message)) return f.model;
  if (/快捷键/.test(message)) return 'hotkey';
  if (/决策上限/.test(message)) return 'maxDecisions';
  if (/本局目标/.test(message)) return 'objective';
  return '';
}
export const publicSettings = s => ({provider:providerId(s.provider), providerName:activeProvider(s).name, providerKind:activeProvider(s).kind, apiBase:s.apiBase, model:s.model, localBase:s.localBase??DEFAULTS.localBase, localModel:s.localModel??DEFAULTS.localModel, hasLocalKey:!!s.localKey,
  openaiBase:s.openaiBase??DEFAULTS.openaiBase, openaiModel:s.openaiModel??'', openaiMode:s.openaiMode==='json'?'json':'tools', strategyMode:strategyMode(s.strategyMode), openaiModels:Array.isArray(s.openaiModels)?s.openaiModels:[], hasOpenaiKey:!!s.openaiKey, hotkey:s.hotkey, autoCamera:s.autoCamera, showOverlay:s.showOverlay??DEFAULTS.showOverlay, autoReport:s.autoReport!==false, allowedHosts:sanitizeAllowedHosts(s.allowedHosts), maxDecisions:s.maxDecisions, objective:s.objective??'', language:s.language??DEFAULTS.language, hasKey:!!s.apiKey});
// For the extension's own popup only: the stored keys, so the form can show them masked.
export const privateSettings = s => ({...publicSettings(s), apiKey:s.apiKey??'', localKey:s.localKey??'', openaiKey:s.openaiKey??''});
export function prepareQuestions(body) {
  if (!body || JSON.stringify(body).length > 256000 || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) throw new Error('战况请求格式或大小无效。');
  const entries = Object.entries(body.groups ?? {});
  if (!entries.length || entries.length > 8) throw new Error('一次请求需要 1–8 个决策组。');
  return Object.fromEntries(entries.map(([id,g]) => {
    const criteria = Object.entries(g?.criteria ?? {});
    if (!/^[a-z_]+$/.test(id) || typeof g.instructions !== 'string' || !g.instructions || !criteria.length || criteria.length > 255 || criteria.some(([k,v])=>!k || typeof v !== 'string')) throw new Error('决策候选无效。');
    return [id,{type:'choice',instructions:g.instructions,criteria:Object.fromEntries(criteria)}];
  }));
}
// Commander requests carry the brief instead of decision groups; it is larger than a choice request.
export const BRIEF_MAX_CHARS = 200000;
export function prepareBrief(body) {
  const brief = body?.brief;
  if (body?.mode !== 'commander' || !brief || typeof brief !== 'object' || Array.isArray(brief) || JSON.stringify(brief).length > BRIEF_MAX_CHARS) throw new Error('指挥请求格式或大小无效。');
  const legal = brief.legal && typeof brief.legal === 'object' && !Array.isArray(brief.legal) ? brief.legal : {};
  return { ...brief, legal };
}
export function validateAnswer(result, questions, name = 'Jev') {
  const answers = {};
  for (const [id,q] of Object.entries(questions)) {
    const a = result.answers?.[id];
    if (a?.type !== 'choice' || !Object.hasOwn(q.criteria,a.choice)) throw new Error(`${name} 返回了未提供的候选，已拒绝执行。`);
    answers[id] = {type:'choice',choice:a.choice,confidence:Number(a.confidence)||0,probabilities:Object.fromEntries(Object.entries(a.probabilities??{}).filter(([k,v])=>Object.hasOwn(q.criteria,k)&&Number.isFinite(v)))};
  }
  return {answers,model:typeof result.model==='string'?result.model:'',usage:{input_tokens:Number(result.usage?.input_tokens)||0,output_tokens:Number(result.usage?.output_tokens)||0}};
}
export function httpError(status, name = 'Jev') {
  return ({401:`${name} 拒绝了密钥（HTTP 401），请检查密钥。`,402:`${name} 返回 HTTP 402，请检查账户额度或计费状态。`,403:`${name} 拒绝访问（HTTP 403），请检查密钥权限和 API 地址。`,429:`${name} 请求过于频繁或额度受限（HTTP 429），请稍后再试。`})[status] ?? `${name} 请求失败（HTTP ${status}）。`;
}
// Request headers for a provider: local services may run without a token.
export const authHeaders = p => ({'Content-Type':'application/json', ...(p.apiKey ? {Authorization:`Bearer ${p.apiKey}`} : {})});

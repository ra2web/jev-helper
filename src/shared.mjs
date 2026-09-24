export const DEFAULTS = /* @__PURE__ */ Object.freeze({ provider: 'jev', apiBase: 'https://api.typesafe.ai/v1', model: 'jev-latest', localBase: 'http://127.0.0.1:8742/v1', localModel: 'laya', hotkey: 'Alt+Shift+J', autoCamera: true, showOverlay: true, maxDecisions: 2000, objective: '', language:'zh-CN' });
export const PROVIDERS = /* @__PURE__ */ Object.freeze({ jev: { id: 'jev', name: 'Jev', requiresKey: true }, local: { id: 'local', name: 'Laya', requiresKey: false } });
// The active provider decides which stored endpoint, key and model the background uses.
export function activeProvider(s) {
  const id = s?.provider === 'local' ? 'local' : 'jev', p = PROVIDERS[id];
  return id === 'local'
    ? { ...p, apiBase: String(s.localBase ?? DEFAULTS.localBase).trim(), apiKey: String(s.localKey ?? '').trim(), model: String(s.localModel ?? DEFAULTS.localModel).trim() }
    : { ...p, apiBase: String(s.apiBase ?? DEFAULTS.apiBase).trim(), apiKey: String(s.apiKey ?? '').trim(), model: String(s.model ?? DEFAULTS.model).trim() };
}
export const GAME_HOSTS = ['ra2web.github.io', 'staging.wangerhuoda.com', 'wangerhuoda.com', 'www.wangerhuoda.com'];
export const CHANNEL = 'werhd-jev-extension-v1';
export function supportedGame(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && GAME_HOSTS.includes(u.hostname) || u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname); } catch { return false; }
}
// Plain HTTP is accepted only for this machine and private LAN addresses (a local model server).
export const privateHost = h => ['localhost','127.0.0.1','[::1]'].includes(h) || /^10\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h) || /\.local$/.test(h);
export function apiEndpoint(value) {
  let u; try { u = new URL(value.trim()); } catch { throw new Error('请输入有效的 API 地址。'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('API 地址不能包含账号、查询参数或片段。');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && privateHost(u.hostname))) throw new Error('API 地址须使用 HTTPS；本机或局域网地址可使用 HTTP。');
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname.endsWith('/systemone')) u.pathname += '/systemone';
  return u.href;
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
  s.provider = s.provider === 'local' ? 'local' : 'jev';
  s.apiBase = String(s.apiBase).trim(); apiEndpoint(s.apiBase);
  s.localBase = String(s.localBase ?? DEFAULTS.localBase).trim(); apiEndpoint(s.localBase);
  s.model = String(s.model).trim();
  s.localModel = String(s.localModel ?? DEFAULTS.localModel).trim();
  if (!/^[\w.\/-]{1,80}$/.test(s.model) || !/^[\w.\/-]{1,80}$/.test(s.localModel)) throw new Error('模型名称无效。');
  s.hotkey = normalizeHotkey(s.hotkey);
  s.maxDecisions = Number(s.maxDecisions);
  if (!Number.isInteger(s.maxDecisions) || s.maxDecisions < 1 || s.maxDecisions > 10000) throw new Error('每局决策上限应为 1–10000。');
  s.autoCamera = Boolean(s.autoCamera);
  s.showOverlay = Boolean(s.showOverlay);
  s.language = s.language === 'en' ? 'en' : 'zh-CN';
  s.objective = String(s.objective ?? '').replace(/\s+/g, ' ').trim();
  if (s.objective.length > 300) throw new Error('本局目标最多 300 个字符。');
  s.apiKey = String(s.apiKey ?? '').trim();
  s.localKey = String(s.localKey ?? '').trim();
  if (s.apiKey.length > 4096 || /[\r\n]/.test(s.apiKey) || s.localKey.length > 4096 || /[\r\n]/.test(s.localKey)) throw new Error('密钥格式无效。');
  return s;
}
// Per-field validation for inline form errors. Same rules as validateSettings, but every field
// is checked independently so each message can sit under its own input.
export function fieldErrors(input, {requireKey = false} = {}) {
  const errors = {}, local = input.provider === 'local';
  const check = (field, fn) => { try { fn(); } catch (e) { errors[field] = e.message; } };
  check(local ? 'localBase' : 'apiBase', () => apiEndpoint(String((local ? input.localBase : input.apiBase) ?? '')));
  const model = String((local ? input.localModel : input.model) ?? '').trim();
  if (!/^[\w.\/-]{1,80}$/.test(model)) errors[local ? 'localModel' : 'model'] = '模型名称无效。';
  check('hotkey', () => normalizeHotkey(input.hotkey ?? ''));
  const n = Number(input.maxDecisions);
  if (!Number.isInteger(n) || n < 1 || n > 10000) errors.maxDecisions = '每局决策上限应为 1–10000。';
  if (String(input.objective ?? '').replace(/\s+/g, ' ').trim().length > 300) errors.objective = '本局目标最多 300 个字符。';
  const keyField = local ? 'localKey' : 'apiKey', key = String(input[keyField] ?? '').trim();
  if (key.length > 4096 || /[\r\n]/.test(key)) errors[keyField] = '密钥格式无效。';
  else if (requireKey && !local && !key) errors.apiKey = '请输入 JEV 密钥。';
  return errors;
}
// Which field a background error belongs to, so the popup can show it inline.
export function errorField(message, provider = 'jev') {
  const local = provider === 'local';
  if (/JEV 密钥|更换 API 服务|密钥格式/.test(message)) return 'apiKey';
  if (/API 地址|API 访问/.test(message)) return local ? 'localBase' : 'apiBase';
  if (/模型名称/.test(message)) return local ? 'localModel' : 'model';
  if (/快捷键/.test(message)) return 'hotkey';
  if (/决策上限/.test(message)) return 'maxDecisions';
  if (/本局目标/.test(message)) return 'objective';
  return '';
}
export const publicSettings = s => ({provider:s.provider==='local'?'local':'jev', providerName:activeProvider(s).name, apiBase:s.apiBase, model:s.model, localBase:s.localBase??DEFAULTS.localBase, localModel:s.localModel??DEFAULTS.localModel, hasLocalKey:!!s.localKey, hotkey:s.hotkey, autoCamera:s.autoCamera, showOverlay:s.showOverlay??DEFAULTS.showOverlay, maxDecisions:s.maxDecisions, objective:s.objective??'', language:s.language??DEFAULTS.language, hasKey:!!s.apiKey});
// For the extension's own popup only: the stored keys, so the form can show them masked.
export const privateSettings = s => ({...publicSettings(s), apiKey:s.apiKey??'', localKey:s.localKey??''});
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackground} from '../src/background-core.mjs';
import {DEFAULTS, activeProvider, serviceUrl, providerEndpoint, fieldErrors, errorField, validateSettings, publicSettings} from '../src/shared.mjs';
import {buildChatRequest, parseChatResponse, modelIds, compactState, choiceSchema, TOOL_NAME} from '../src/openai.mjs';

const questions = {
  tactics: {type:'choice', instructions:'Choose a mission', criteria:{wait:'Hold', attack:'Attack the base'}},
  vehicles: {type:'choice', instructions:'Build next', criteria:{wait:'Nothing', produce_HTNK:'Rhino tank'}},
};
const toolReply = (args, extra = {}) => ({model:'gpt-test-2', choices:[{message:{role:'assistant', tool_calls:[{type:'function', function:{name:TOOL_NAME, arguments:JSON.stringify(args)}}]}}], usage:{prompt_tokens:1200, completion_tokens:60}, ...extra});

test('tool-call request carries state, options and a schema that only allows offered keys', () => {
  const body = buildChatRequest({model:'gpt-x', state:{tick:5, units:[1, 2]}, questions});
  assert.equal(body.model, 'gpt-x');
  assert.deepEqual(body.tool_choice, {type:'function', function:{name:TOOL_NAME}});
  const params = body.tools[0].function.parameters;
  assert.deepEqual(params.required, ['tactics', 'vehicles']);
  assert.deepEqual(params.properties.vehicles.properties.choice.enum, ['wait', 'produce_HTNK']);
  const user = JSON.parse(body.messages.at(-1).content);
  assert.equal(user.state.tick, 5);
  assert.deepEqual(user.decisions.tactics, {instructions:'Choose a mission', options:{wait:'Hold', attack:'Attack the base'}});
  assert.equal(body.response_format, undefined);
  assert.deepEqual(choiceSchema(questions).properties.tactics.required, ['choice']);
});

test('JSON mode asks for a bare object and uses no tools', () => {
  const body = buildChatRequest({model:'m', mode:'json', state:{}, questions});
  assert.deepEqual(body.response_format, {type:'json_object'});
  assert.equal(body.tools, undefined);
  assert.match(body.messages[0].content, /"tactics":\{"choice":"<option key>"/);
});

test('large states are shortened, scalars first, under the size limit', () => {
  const state = {units:Array.from({length:500}, (_, i) => ({id:i, name:'HTNK', hp:1})), tick:9, credits:100};
  const small = compactState(state, 6000);
  assert.deepEqual(Object.keys(small), ['tick', 'credits', 'units']);
  assert.ok(JSON.stringify(small).length <= 6000);
  assert.match(String(small.units.at(-1)), /more$/);
  assert.equal(compactState(state).units.length, 500); // under the default limit nothing is cut
  const huge = {units:Array.from({length:3000}, (_, i) => ({id:i, name:'HTNK', x:i, y:i, hp:1}))};
  assert.equal(compactState(huge).units.length, 25); // 24 kept plus a marker
});

test('replies map to Jev answers: tool calls, fenced JSON, wrappers and token usage', () => {
  const a = parseChatResponse(toolReply({tactics:{choice:'attack', confidence:.9, reason:'Enemy base is weak.'}, vehicles:{choice:'produce_HTNK'}}), questions);
  assert.equal(a.model, 'gpt-test-2');
  assert.deepEqual(a.usage, {input_tokens:1200, output_tokens:60});
  assert.deepEqual(a.answers.tactics, {type:'choice', choice:'attack', confidence:.9, probabilities:{}, reason:'Enemy base is weak.'});
  assert.equal(a.answers.vehicles.confidence, 0);
  const fenced = {choices:[{message:{content:'Sure:\n```json\n{"answers":{"tactics":"attack","vehicles":{"choice":"wait"}}}\n```'}}]};
  const b = parseChatResponse(fenced, questions);
  assert.equal(b.answers.tactics.choice, 'attack');
  assert.equal(b.answers.vehicles.choice, 'wait');
  assert.deepEqual(b.usage, {input_tokens:0, output_tokens:0});
});

test('an unknown or missing choice falls back to wait and is flagged; nothing usable is rejected', () => {
  const a = parseChatResponse(toolReply({tactics:{choice:'nuke_everything'}, vehicles:{choice:'produce_HTNK'}}), questions);
  assert.deepEqual(a.answers.tactics, {type:'choice', choice:'wait', confidence:0, probabilities:{}, fallback:true});
  assert.equal(a.answers.vehicles.choice, 'produce_HTNK');
  assert.throws(() => parseChatResponse(toolReply({tactics:{choice:'x'}}), questions), /未提供的候选/);
  assert.throws(() => parseChatResponse({choices:[{message:{content:'I think you should attack.'}}]}, questions), /无法解析/);
  const noWait = {only:{type:'choice', instructions:'Pick', criteria:{a:'A', b:'B'}}, tactics:questions.tactics};
  assert.throws(() => parseChatResponse(toolReply({only:{choice:'c'}, tactics:{choice:'attack'}}), noWait), /未提供的候选/);
});

test('model lists are read from OpenAI and similar shapes, deduplicated and sorted', () => {
  assert.deepEqual(modelIds({object:'list', data:[{id:'gpt-b'}, {id:'gpt-a'}, {id:'gpt-a'}, {id:'bad id with spaces'}]}), ['gpt-a', 'gpt-b']);
  assert.deepEqual(modelIds({models:[{name:'qwen2.5:7b'}, 'llama3@latest']}), ['llama3@latest', 'qwen2.5:7b']);
  assert.deepEqual(modelIds(null), []);
});

test('OpenAI provider settings: endpoints, cloud or local, key rule and model validation', () => {
  const cloud = activeProvider({provider:'openai', openaiBase:'https://relay.example.com/v1/chat/completions', openaiKey:' k ', openaiModel:'gpt-4.1'});
  assert.equal(cloud.kind, 'cloud'); assert.equal(cloud.requiresKey, true); assert.equal(cloud.apiKey, 'k'); assert.equal(cloud.mode, 'tools');
  assert.equal(providerEndpoint(cloud), 'https://relay.example.com/v1/chat/completions');
  assert.equal(serviceUrl('https://relay.example.com/v1/', '/models'), 'https://relay.example.com/v1/models');
  assert.equal(serviceUrl('https://api.deepseek.com', '/chat/completions'), 'https://api.deepseek.com/chat/completions');
  assert.equal(serviceUrl('https://api.deepseek.com/', '/models'), 'https://api.deepseek.com/models');
  const lan = activeProvider({provider:'openai', openaiBase:'http://192.168.1.20:11434/v1', openaiMode:'json'});
  assert.equal(lan.kind, 'local'); assert.equal(lan.requiresKey, false); assert.equal(lan.mode, 'json');
  assert.equal(activeProvider({provider:'jev'}).kind, 'cloud'); assert.equal(activeProvider({provider:'local'}).kind, 'local');
  const base = {...DEFAULTS, provider:'openai'};
  assert.deepEqual(fieldErrors({...base, openaiKey:''}, {requireKey:true}), {openaiKey:'请输入 API 密钥。'});
  assert.deepEqual(fieldErrors({...base, openaiBase:'http://127.0.0.1:1234/v1', openaiKey:''}, {requireKey:true}), {});
  assert.deepEqual(fieldErrors({...base, openaiModel:'bad model'}), {openaiModel:'模型名称无效。'});
  assert.equal(validateSettings({...base, openaiModel:'qwen2.5:14b-instruct'}).openaiModel, 'qwen2.5:14b-instruct');
  assert.equal(errorField('请先获取模型列表并选择模型。', 'openai'), 'openaiModel');
  assert.equal(errorField('API 地址须以 http:// 或 https:// 开头。', 'openai'), 'openaiBase');
  assert.equal(errorField('更换 API 服务时，请重新输入该服务的密钥。', 'openai'), 'openaiKey');
  assert.equal(errorField('请输入 JEV 密钥。', 'jev'), 'apiKey');
  assert.doesNotMatch(JSON.stringify(publicSettings({...base, openaiKey:'sk-secret'})), /sk-secret/);
});

// Background: same harness as background.test.mjs, with the OpenAI provider selected.
const extension = {id:'test-extension', url:'chrome-extension://test-extension/popup.html'};
const sender = {id:'test-extension', frameId:0, documentId:'document-1', url:'https://staging.wangerhuoda.com/', tab:{id:7}};
const body = {state:{tick:100}, groups:{tactics:{instructions:'Choose', criteria:{wait:'Wait', attack:'Attack'}}}};
function mockChrome(settings) {
  const data = {local:{settings:{...DEFAULTS, ...settings}}, session:{}}, listeners = {}, downloads = [];
  const area = name => ({setAccessLevel:async () => {}, get:async key => structuredClone(key === null ? data[name] : {[key]:data[name][key]}), set:async values => Object.assign(data[name], structuredClone(values)), remove:async key => { for (const k of Array.isArray(key) ? key : [key]) delete data[name][k]; }});
  const c = {storage:{local:area('local'), session:area('session')}, runtime:{id:'test-extension', getURL:p => 'chrome-extension://test-extension/' + p, onMessage:{addListener:() => {}}}, permissions:{contains:async () => true},
    tabs:{get:async () => ({id:7, url:sender.url, title:'王二火大'}), query:async () => [], sendMessage:async () => ({ok:true}), onUpdated:{addListener:() => {}}, onRemoved:{addListener:() => {}}},
    action:{setBadgeText:async () => {}, setBadgeBackgroundColor:async () => {}}, downloads:{download:async x => { downloads.push(x); return 1; }},
    scripting:{executeScript:async x => [{documentId:sender.documentId, result:x.args?.[0] === 'start' ? {running:true} : x.args?.[0] === 'stop' ? {running:false} : {available:true, running:!!data.session['session:7']?.running}}]}};
  return {c, data, listeners, downloads};
}
const openaiSettings = {provider:'openai', openaiBase:'https://relay.example.com/v1', openaiKey:'sk-test-only', openaiModel:'gpt-test', apiKey:'jev-secret'};

test('OpenAI source: chat completions with the key, answers executed, tokens and model info kept in the match record', async () => {
  const calls = [];
  const mock = mockChrome(openaiSettings);
  const app = createBackground(mock.c, {fetchImpl:async (url, options) => { calls.push({url, options}); return new Response(JSON.stringify(toolReply({tactics:{choice:'attack', confidence:.7, reason:'Push now.'}}))); }});
  await app.ready;
  await app.handle({type:'START', tabId:7}, extension);
  const s = await app.getSession(7);
  assert.equal(s.provider, 'openai'); assert.equal(s.providerKind, 'cloud'); assert.equal(s.endpoint, 'https://relay.example.com/v1/chat/completions'); assert.equal(s.model, 'gpt-test'); assert.equal(s.callMode, 'tools');
  const result = await app.handle({type:'DECIDE', token:s.token, body}, sender);
  assert.equal(result.answers.tactics.choice, 'attack');
  assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-only');
  assert.equal(calls[0].options.redirect, 'error');
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.model, 'gpt-test'); assert.equal(sent.tools[0].function.name, TOOL_NAME);
  const after = await app.getSession(7);
  assert.equal(after.inputTokens, 1200); assert.equal(after.outputTokens, 60); assert.equal(after.model, 'gpt-test-2');
  await app.handle({type:'STOP', tabId:7}, extension);
  const {matches} = await app.handle({type:'MATCHES_LIST'}, extension);
  const m = matches[0];
  assert.equal(m.provider, 'openai'); assert.equal(m.providerName, 'OpenAI'); assert.equal(m.providerKind, 'cloud');
  assert.equal(m.model, 'gpt-test-2'); assert.equal(m.configuredModel, 'gpt-test'); assert.equal(m.callMode, 'tools');
  assert.equal(m.endpoint, 'https://relay.example.com/v1/chat/completions');
  assert.equal(m.inputTokens, 1200); assert.equal(m.outputTokens, 60); assert.equal(m.totalTokens, 1260);
  const {entries} = await app.handle({type:'MATCH_LOG_GET', id:m.id}, extension);
  const decision = entries.find(e => e.kind === 'decision');
  assert.equal(decision.outputTokens, 60); assert.equal(decision.groups.tactics.reason, 'Push now.');
  assert.equal(entries.find(e => e.kind === 'session' && e.event === 'start').endpoint, 'https://relay.example.com/v1/chat/completions');
  assert.doesNotMatch(JSON.stringify([matches, entries, mock.downloads]), /sk-test-only|jev-secret/);
});

test('Jev and local matches also record whether they were cloud or local, the endpoint and output tokens', async () => {
  const mock = mockChrome({provider:'local'});
  const app = createBackground(mock.c, {fetchImpl:async () => new Response(JSON.stringify({answers:{tactics:{type:'choice', choice:'wait'}}, model:'laya-multilingual-mlx', usage:{input_tokens:300, output_tokens:0}}))});
  await app.ready; await app.handle({type:'START', tabId:7}, extension);
  const s = await app.getSession(7);
  await app.handle({type:'DECIDE', token:s.token, body}, sender);
  await app.handle({type:'STOP', tabId:7}, extension);
  const [m] = (await app.handle({type:'MATCHES_LIST'}, extension)).matches;
  assert.equal(m.providerKind, 'local'); assert.equal(m.endpoint, 'http://127.0.0.1:8742/v1/systemone'); assert.equal(m.configuredModel, 'laya');
  assert.equal(m.inputTokens, 300); assert.equal(m.outputTokens, 0); assert.equal(m.totalTokens, 300);
});

test('model list: popup only, GET /models with the key, remembered for the saved base, never sends the saved key elsewhere', async () => {
  const calls = [];
  const mock = mockChrome({...openaiSettings, openaiModel:''});
  const app = createBackground(mock.c, {fetchImpl:async (url, options) => { calls.push({url, options}); return new Response(JSON.stringify({object:'list', data:[{id:'gpt-b'}, {id:'gpt-a'}]})); }});
  await app.ready;
  await assert.rejects(app.handle({type:'LIST_MODELS'}, sender));
  const listed = await app.handle({type:'LIST_MODELS'}, extension);
  assert.deepEqual(listed.models, ['gpt-a', 'gpt-b']);
  assert.equal(calls[0].url, 'https://relay.example.com/v1/models'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-only');
  assert.deepEqual(mock.data.local.settings.openaiModels, ['gpt-a', 'gpt-b']);
  assert.deepEqual((await app.handle({type:'GET_SETTINGS'}, extension)).openaiModels, ['gpt-a', 'gpt-b']);
  // A different service with the stored key is refused; with its own key it works but is not remembered.
  await assert.rejects(app.handle({type:'LIST_MODELS', base:'https://other.example.com/v1', apiKey:'sk-test-only'}, extension), /重新输入/);
  const other = await app.handle({type:'LIST_MODELS', base:'https://other.example.com/v1', apiKey:'sk-other'}, extension);
  assert.equal(calls.at(-1).url, 'https://other.example.com/v1/models'); assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sk-other');
  assert.equal(other.models.length, 2); assert.deepEqual(mock.data.local.settings.openaiModels, ['gpt-a', 'gpt-b']);
  // A model is needed before testing or starting.
  await assert.rejects(app.handle({type:'TEST_CONNECTION'}, extension), /选择模型/);
  await assert.rejects(app.handle({type:'START', tabId:7}, extension), /选择模型/);
});

test('model list errors are clear: empty list, HTTP failure with the service message, missing access', async () => {
  let reply = new Response(JSON.stringify({data:[]}));
  const mock = mockChrome(openaiSettings);
  const app = createBackground(mock.c, {fetchImpl:async () => reply});
  await app.ready;
  await assert.rejects(app.handle({type:'LIST_MODELS'}, extension), /模型列表为空/);
  reply = new Response(JSON.stringify({error:{message:'Incorrect API key provided'}}), {status:401});
  await assert.rejects(app.handle({type:'LIST_MODELS'}, extension), /HTTP 401.*Incorrect API key/);
  mock.c.permissions.contains = async () => false;
  await assert.rejects(app.handle({type:'LIST_MODELS'}, extension), /授权/);
});

test('connection test, saving and key rules for the OpenAI source', async () => {
  let reply = () => new Response(JSON.stringify(toolReply({connection:{choice:'ok'}})));
  const calls = [];
  const mock = mockChrome(openaiSettings);
  const app = createBackground(mock.c, {fetchImpl:async (url, options) => { calls.push({url, options}); return reply(); }});
  await app.ready;
  const probe = await app.handle({type:'TEST_CONNECTION'}, extension);
  assert.equal(probe.providerName, 'OpenAI'); assert.equal(probe.model, 'gpt-test-2'); assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions');
  reply = () => new Response(JSON.stringify({error:{message:'The model `gpt-test` does not exist'}}), {status:404});
  await assert.rejects(app.handle({type:'TEST_CONNECTION'}, extension), /HTTP 404.*does not exist/);
  // Moving to another service with the same stored key is refused; a new key is accepted and the list is reset.
  await assert.rejects(app.handle({type:'SAVE_SETTINGS', settings:{provider:'openai', openaiBase:'https://other.example.com/v1', openaiKey:'sk-test-only'}}, extension), /重新输入/);
  const saved = await app.handle({type:'SAVE_SETTINGS', settings:{provider:'openai', openaiBase:'https://other.example.com/v1', openaiKey:'sk-other', openaiModel:'m1', openaiMode:'json', openaiModels:['m1', 'm2']}}, extension);
  assert.equal(saved.openaiBase, 'https://other.example.com/v1'); assert.equal(saved.openaiMode, 'json'); assert.deepEqual(saved.openaiModels, ['m1', 'm2']); assert.equal(saved.openaiKey, 'sk-other');
  assert.equal(saved.origin, 'https://other.example.com/*');
  // Clearing the OpenAI key leaves the Jev key alone.
  await app.handle({type:'CLEAR_KEY', provider:'openai'}, extension);
  assert.equal(mock.data.local.settings.openaiKey, ''); assert.equal(mock.data.local.settings.apiKey, 'jev-secret');
  await assert.rejects(app.handle({type:'START', tabId:7}, extension), /API 密钥/);
});

test('a slow chat model gets a longer timeout and more stale-tick room than Jev', async () => {
  const mock = mockChrome(openaiSettings);
  const scripts = []; const exec = mock.c.scripting.executeScript; mock.c.scripting.executeScript = async x => { scripts.push(x); return exec(x); };
  const app = createBackground(mock.c, {fetchImpl:async () => new Response(JSON.stringify(toolReply({tactics:{choice:'wait'}})))});
  await app.ready; await app.handle({type:'START', tabId:7}, extension);
  const start = scripts.find(x => x.args?.[0] === 'start');
  assert.equal(start.args[1].maxStaleTicks, 900); assert.equal(start.args[1].requestTimeoutMs, 35000);
  const s = await app.getSession(7);
  // A reply with only fallbacks is still one decision; the fallback is visible in the log.
  const result = await app.handle({type:'DECIDE', token:s.token, body:{state:{tick:1}, groups:{tactics:{instructions:'x', criteria:{wait:'W', attack:'A'}}, vehicles:{instructions:'y', criteria:{wait:'W', build:'B'}}}}}, sender);
  assert.equal(result.answers.vehicles.fallback, true);
  const {entries} = await app.handle({type:'LOG_EXPORT'}, extension);
  assert.equal(entries.find(e => e.kind === 'decision').groups.vehicles.fallback, true);
  const jev = mockChrome({apiKey:'k'}); const jevScripts = []; const jexec = jev.c.scripting.executeScript; jev.c.scripting.executeScript = async x => { jevScripts.push(x); return jexec(x); };
  const jevApp = createBackground(jev.c, {fetchImpl:async () => new Response('{}')}); await jevApp.ready; await jevApp.handle({type:'START', tabId:7}, extension);
  const jevStart = jevScripts.find(x => x.args?.[0] === 'start').args[1];
  assert.equal(jevStart.maxStaleTicks, undefined); assert.equal(jevStart.requestTimeoutMs, undefined);
});

test('a service that refuses a forced function call is retried once with tool_choice auto and remembered', async () => {
  const calls = [];
  const mock = mockChrome({...openaiSettings, openaiModel:'deepseek-flash'});
  const app = createBackground(mock.c, {fetchImpl:async (url, options) => {
    const sent = JSON.parse(options.body); calls.push(sent.tool_choice);
    if (typeof sent.tool_choice === 'object') return new Response(JSON.stringify({error:{message:'Thinking mode does not support this tool_choice'}}), {status:400});
    return new Response(JSON.stringify(toolReply({tactics:{choice:'attack'}})));
  }});
  await app.ready; await app.handle({type:'START', tabId:7}, extension);
  const s = await app.getSession(7);
  assert.equal((await app.handle({type:'DECIDE', token:s.token, body}, sender)).answers.tactics.choice, 'attack');
  assert.equal(calls.length, 2); assert.equal(typeof calls[0], 'object'); assert.equal(calls[1], 'auto');
  await new Promise(r => setTimeout(r, 5));
  await app.handle({type:'DECIDE', token:s.token, body}, sender);
  assert.deepEqual(calls.slice(2), ['auto']); // remembered: no second refusal
  assert.equal((await app.getSession(7)).failures, 0);
  const auto = buildChatRequest({model:'m', state:{}, questions, toolChoice:'auto'});
  assert.equal(auto.tool_choice, 'auto'); assert.match(auto.messages[0].content, /Always answer by calling submit_choices/);
});

test('a prose answer to a function-call request is retried once as JSON, and only a second failure counts', async () => {
  const calls = [];
  const mock = mockChrome({...openaiSettings, openaiModel:'deepseek-flash'});
  let proseAgain = false;
  const app = createBackground(mock.c, {fetchImpl:async (url, options) => {
    const sent = JSON.parse(options.body); calls.push(sent.response_format ? 'json' : 'tools');
    if (!sent.response_format || proseAgain) return new Response(JSON.stringify({model:'deepseek-flash', choices:[{message:{content:'I would attack the base now.'}}]}));
    return new Response(JSON.stringify({model:'deepseek-flash', choices:[{message:{content:'{"tactics":{"choice":"attack","reason":"push"}}'}}], usage:{prompt_tokens:10, completion_tokens:5}}));
  }});
  await app.ready; await app.handle({type:'START', tabId:7}, extension);
  const s = await app.getSession(7);
  const result = await app.handle({type:'DECIDE', token:s.token, body}, sender);
  assert.equal(result.answers.tactics.choice, 'attack'); assert.deepEqual(calls, ['tools', 'json']);
  assert.equal((await app.getSession(7)).failures, 0);
  proseAgain = true; await new Promise(r => setTimeout(r, 5));
  await assert.rejects(app.handle({type:'DECIDE', token:s.token, body}, sender), /无法解析/);
  assert.deepEqual(calls.slice(2), ['tools', 'json']); assert.equal((await app.getSession(7)).failures, 1);
});

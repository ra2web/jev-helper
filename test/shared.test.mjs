import test from 'node:test';
import assert from 'node:assert/strict';
import {apiEndpoint,originPattern,validateSettings,publicSettings,normalizeHotkey,hotkeyFromEvent,prepareQuestions,validateAnswer,supportedGame,activeProvider,authHeaders,httpError,fieldErrors,errorField,plaintextPublic,hostAllowed,normalizeHost,sanitizeAllowedHosts} from '../src/shared.mjs';
test('API configuration accepts a base/full endpoint, confines plaintext to loopback and strips no secret into public settings',()=>{
  assert.equal(apiEndpoint('https://api.typesafe.ai/v1/'),'https://api.typesafe.ai/v1/systemone');
  assert.equal(apiEndpoint('https://example.test/proxy/systemone'),'https://example.test/proxy/systemone');
  assert.equal(originPattern('http://127.0.0.1:8742/v1'),'http://127.0.0.1/*');
  assert.equal(apiEndpoint('http://192.168.1.20:8742/v1'),'http://192.168.1.20:8742/v1/systemone');assert.equal(originPattern('http://10.0.0.5:8742/v1'),'http://10.0.0.5/*');assert.equal(apiEndpoint('http://mac-studio.local:8742/v1'),'http://mac-studio.local:8742/v1/systemone');
  // Any reachable address is accepted; only the plaintext-over-public warning distinguishes networks.
  for(const quiet of ['http://100.118.47.84:8742/v1','http://100.64.0.1/v1','http://100.127.255.254/v1','http://mac-studio.tail1234.ts.net:8742/v1','http://mac-studio:8742/v1','http://nas.lan/v1','http://box.home.arpa/v1','http://169.254.10.10/v1','http://[fd7a:115c:a1e0::1]:8742/v1','http://[fe80::1]/v1','http://172.31.255.1/v1','https://example.com/v1']){assert.doesNotThrow(()=>apiEndpoint(quiet),quiet);assert.equal(plaintextPublic(quiet),false,quiet);}
  for(const warned of ['http://example.com/v1','http://8.8.8.8/v1','http://172.32.0.1/v1','http://100.128.0.1/v1','http://100.63.255.255/v1','http://api.typesafe.ai/v1','http://[2001:db8::1]/v1','http://my-vps.example.org:8742/v1']){assert.doesNotThrow(()=>apiEndpoint(warned),warned);assert.equal(plaintextPublic(warned),true,warned);}
  for(const bad of ['ftp://example.com/v1','https://secret@example.com/v1','https://example.com/?key=secret','file:///tmp/api','https://example.com/#x','not a url'])assert.throws(()=>apiEndpoint(bad),bad);
  assert.equal('apiKey' in publicSettings(validateSettings({apiKey:'test-only-secret'})),false);
  assert.equal(supportedGame('https://ra2web.github.io/'),true);assert.equal(supportedGame('https://ra2web.github.io.evil.test/'),false);
});
test('custom keyboard chord uses physical keys and exact modifiers',()=>{
  assert.equal(normalizeHotkey('alt+SHIFT+j'),'Alt+Shift+J');
  assert.equal(hotkeyFromEvent({code:'KeyJ',altKey:true,shiftKey:true,key:'Ô'}),'Alt+Shift+J');
  assert.equal(hotkeyFromEvent({code:'KeyJ',metaKey:true}),'Meta+J');
  for(const bad of ['J','Shift+J','Bogus+J','Ctrl+Bogus+J'])assert.throws(()=>normalizeHotkey(bad));
});
test('Jev results are constrained to the submitted candidate set',()=>{
  const questions=prepareQuestions({state:{tick:1},groups:{tactics:{instructions:'Select',criteria:{wait:'Wait',attack:'Attack'}}}});
  assert.throws(()=>validateAnswer({answers:{tactics:{type:'choice',choice:'sell_everything'}}},questions));
  assert.throws(()=>validateAnswer({answers:{}},questions));
  const result=validateAnswer({answers:{tactics:{type:'choice',choice:'attack'},injected:{choice:'bad'}},apiKey:'malicious'},questions);
  assert.deepEqual(Object.keys(result.answers),['tactics']);assert.equal('apiKey' in result,false);
  assert.throws(()=>prepareQuestions({state:{},groups:Object.fromEntries(Array.from({length:9},(_,i)=>['x'+i,{}]))}));
});
test('two model sources keep separate endpoints and keys; the local source needs no key and never leaks it',()=>{
  const jev=validateSettings({apiKey:'jev-secret',localKey:'local-secret'});
  assert.equal(activeProvider(jev).id,'jev');assert.equal(activeProvider(jev).apiBase,'https://api.typesafe.ai/v1');assert.equal(activeProvider(jev).apiKey,'jev-secret');assert.equal(activeProvider(jev).requiresKey,true);
  const local=validateSettings({provider:'local',apiKey:'jev-secret',localBase:'http://127.0.0.1:8742/v1/'});
  const p=activeProvider(local);assert.equal(p.id,'local');assert.equal(p.name,'Laya');assert.equal(p.requiresKey,false);assert.equal(p.apiKey,'');assert.equal(apiEndpoint(p.apiBase),'http://127.0.0.1:8742/v1/systemone');
  assert.deepEqual(authHeaders(p),{'Content-Type':'application/json'});assert.equal(authHeaders(activeProvider(jev)).Authorization,'Bearer jev-secret');
  assert.equal(validateSettings({provider:'anything-else'}).provider,'jev');
  const padded=validateSettings({apiBase:'  https://api.typesafe.ai/v1  ',apiKey:'  padded-key\t',localBase:' http://127.0.0.1:8742/v1 ',localKey:' t ',model:' jev-latest '});
  assert.equal(padded.apiBase,'https://api.typesafe.ai/v1');assert.equal(padded.apiKey,'padded-key');assert.equal(padded.localBase,'http://127.0.0.1:8742/v1');assert.equal(padded.localKey,'t');assert.equal(padded.model,'jev-latest');
  const raw=activeProvider({provider:'local',localBase:' http://127.0.0.1:8742/v1 ',localKey:' tok '});assert.equal(raw.apiBase,'http://127.0.0.1:8742/v1');assert.equal(authHeaders(raw).Authorization,'Bearer tok');
  assert.throws(()=>validateSettings({provider:'local',localBase:'http://example.com/v1'}),/允许的外部地址/,'public plaintext needs an explicit allow');
  assert.equal(validateSettings({provider:'local',localBase:'http://example.com/v1',allowedHosts:['Example.COM']}).localBase,'http://example.com/v1');
  assert.doesNotThrow(()=>validateSettings({provider:'local',localBase:'https://example.com/v1'}),'https public needs nothing');
  assert.doesNotThrow(()=>validateSettings({provider:'local',localBase:'http://100.118.47.84:8742/v1'}),'private networks need nothing');
  assert.equal(normalizeHost(' HTTP://Laya.Example.com:8742/v1 '),'laya.example.com');assert.equal(normalizeHost('203.0.113.5:8742'),'203.0.113.5');assert.equal(normalizeHost('[fd00::1]:8742'),'fd00::1');assert.throws(()=>normalizeHost(''));assert.throws(()=>normalizeHost('user:pw@host'));for(const junk of ['!!','not a host!!','not%20a%20host','-bad.example','host_name','a..b'])assert.throws(()=>normalizeHost(junk),junk);
  assert.deepEqual(sanitizeAllowedHosts(['a.example',' A.EXAMPLE ','bad host!!',null,'b.example']),['a.example','b.example']);assert.equal(sanitizeAllowedHosts(Array.from({length:40},(_,i)=>`h${i}.example`)).length,32);
  assert.equal(hostAllowed('http://example.com/v1',[]),false);assert.equal(hostAllowed('http://example.com/v1',['example.com']),true);assert.equal(hostAllowed('https://example.com/v1',[]),true);assert.equal(hostAllowed('http://10.1.2.3/v1',[]),true);
  assert.equal(fieldErrors({provider:'local',localBase:'http://vps.example/v1',localModel:'laya',hotkey:'Alt+J',maxDecisions:1,localKey:''}).localBase,'公网明文地址需要先加入「允许的外部地址」。');assert.equal(errorField('公网明文地址需要先加入「允许的外部地址」。','local'),'localBase');
  assert.throws(()=>validateSettings({localModel:'bad name!'}));
  const shown=publicSettings(jev);assert.equal(shown.provider,'jev');assert.equal(shown.providerName,'Jev');assert.equal(shown.hasLocalKey,true);assert.equal(shown.localBase,'http://127.0.0.1:8742/v1');
  assert.doesNotMatch(JSON.stringify(shown),/secret/);
  assert.match(httpError(401,'Laya'),/^Laya 拒绝了密钥/);assert.match(httpError(500),/^Jev 请求失败/);
  assert.throws(()=>validateAnswer({answers:{}},{tactics:{criteria:{wait:''}}},'Laya'),/Error: Laya 返回了未提供的候选/);
});
test('inline validation reports every invalid field at once and maps background errors to fields',()=>{
  const bad={provider:'jev',apiBase:'ftp://example.com/v1',apiKey:'',model:'bad name!',hotkey:'J',maxDecisions:0,localBase:'nonsense',localKey:'x\ny'};
  const errors=fieldErrors(bad,{requireKey:true});
  assert.deepEqual(Object.keys(errors).sort(),['apiBase','apiKey','hotkey','maxDecisions','model']);
  assert.equal(errors.apiKey,'请输入 JEV 密钥。');assert.match(errors.apiBase,/http/);assert.equal(errors.model,'模型名称无效。');
  assert.deepEqual(fieldErrors({...bad,provider:'local'}),{localBase:'请输入有效的 API 地址。',localModel:'模型名称无效。',hotkey:'快捷键需要 Ctrl、Alt 或 Meta 加一个字母、数字或 F1–F12。',maxDecisions:'每局决策上限应为 1–10000。',localKey:'密钥格式无效。'});
  assert.deepEqual(fieldErrors({provider:'jev',apiBase:' https://api.typesafe.ai/v1 ',model:'jev-latest',hotkey:'Alt+Shift+J',maxDecisions:2000,apiKey:''},{requireKey:false}),{});
  assert.deepEqual(fieldErrors({provider:'local',localBase:'http://127.0.0.1:8742/v1',localModel:'laya',hotkey:'Alt+Shift+J',maxDecisions:10,localKey:''},{requireKey:true}),{});
  assert.equal(errorField('请先填写并保存 JEV 密钥。'),'apiKey');assert.equal(errorField('更换 API 服务时，请重新输入该服务的密钥。'),'apiKey');
  assert.equal(errorField('请输入有效的 API 地址。'),'apiBase');assert.equal(errorField('尚未授权访问模型服务地址，请在插件中点击「授权访问」。','local'),'','authorization is not a field error');assert.equal(errorField('API 访问权限已被撤销，请重新保存设置。'),'');assert.equal(errorField('请输入有效的 API 地址。','local'),'localBase');
  assert.equal(fieldErrors({provider:'jev',apiBase:'https://api.typesafe.ai/v1',model:'m',hotkey:'Alt+J',maxDecisions:1,apiKey:'k',objective:'o'.repeat(301)}).objective,'本局目标最多 300 个字符。');assert.equal(errorField('本局目标最多 300 个字符。'),'objective');
  assert.equal(errorField('模型名称无效。','local'),'localModel');assert.equal(errorField('每局决策上限应为 1–10000。'),'maxDecisions');assert.equal(errorField('托管未能启动。'),'');
});

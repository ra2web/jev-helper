import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('self-contained MV3 package has no remote modules, localhost bridge, eval or broad required hosts',async()=>{
  const manifest=JSON.parse(await fs.readFile('dist/manifest.json'));
  const pkg=JSON.parse(await fs.readFile('package.json'));
  assert.equal(manifest.version,pkg.version);
  assert.equal(manifest.manifest_version,3);assert.equal(manifest.background.type,'module');
  assert.equal(manifest.web_accessible_resources,undefined);
  assert.ok(!manifest.host_permissions.includes('https://*/*'));assert.ok(!manifest.permissions.includes('debugger'));
  // Chrome match patterns cannot wildcard IP octets, so the optional set is scheme-wide and the exact origin is requested at save time.
  for(const p of manifest.optional_host_permissions)assert.match(p,/^https?:\/\/(\*|[a-z0-9.-]+|\*\.[a-z0-9.-]+)\/\*$/,p);
  for(const f of ['background.js','content.js','page.js','popup.js','popup.html','popup.css','help.html','dashboard.html','dashboard.css','dashboard.js','icons/128.png'])await fs.access('dist/'+f);
  const popupHtml=await fs.readFile('dist/popup.html','utf8');assert.doesNotMatch(popupHtml,/panel-matches|log-export/,'history lives in the dashboard, not the popup');assert.match(popupHtml,/open-dashboard/);
  const page=await fs.readFile('dist/page.js','utf8');assert.doesNotMatch(page,/127\.0\.0\.1:5174|127\.0\.0\.1:8742|api\.typesafe\.ai|Authorization|JEV_API_KEY|\beval\s*\(|\bfetch\s*\(/);
  const scripts=await Promise.all(['background.js','content.js','page.js','popup.js','dashboard.js'].map(f=>fs.readFile('dist/'+f,'utf8')));
  for(const s of scripts)assert.doesNotMatch(s,/import\s*\(\s*['"]https?:/);
});

// Summarize a decision log for offline analysis. Accepts either the JSON exported from the
// extension popup (jev-log-*.json) or the JSON-lines file written by tools/laya-server.py --log.
//   node tools/analyze-log.mjs ~/Downloads/jev-log-20260924-1200.json
//   node tools/analyze-log.mjs ~/laya-decisions.ndjson
import fs from 'node:fs/promises';
import {logStats} from '../src/logbook.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/analyze-log.mjs <jev-log.json | laya-decisions.ndjson>'); process.exit(1); }
const text = await fs.readFile(file, 'utf8');
const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '—';
const list = obj => Object.entries(obj ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || '—';

if (text.trimStart().startsWith('{') && text.includes('"entries"')) {
  const data = JSON.parse(text);
  const s = data.stats ?? logStats(data.entries ?? []);
  console.log(`扩展日志 ${file}`);
  console.log(`导出时间 ${data.exportedAt ?? '?'} · 版本 ${data.version ?? '?'} · 来源 ${data.settings?.provider ?? '?'} (${data.settings?.providerName ?? ''})`);
  console.log(`记录 ${s.entries} 条 · 托管 ${s.sessions} 次 · 决策 ${s.decisions} 次 · 请求失败 ${s.failures} · 过期 ${s.stale} · 平均响应 ${s.latency.avg ?? '—'} ms（最大 ${s.latency.max ?? '—'}）`);
  console.log(`动作：受理 ${s.actions.accepted} · 等待 ${s.actions.waits} · 未执行 ${s.actions.skipped}（${list(s.actions.skippedReasons)}）`);
  console.log(`受理生产：${list(s.actions.acceptedProduce)}`);
  console.log(`按类型受理：${list(s.actions.byType)} · 对局结果：${list(s.outcomes)}`);
  console.log('\n各决策组：');
  for (const [id, g] of Object.entries(s.groups)) console.log(`  ${id.padEnd(13)} 问 ${String(g.asked).padStart(4)} 次 · 等待率 ${String(g.waitRate).padStart(3)}% · 平均候选 ${g.avgOptions} · 置信 ${g.avgConfidence} · 常选：${list(g.choices)}`);
  const decisions = (data.entries ?? []).filter(e => e.kind === 'decision');
  const autos = (data.entries ?? []).filter(e => e.kind === 'action' && e.auto);
  if (autos.length) console.log(`\n自动兜底动作：${list(autos.reduce((m, a) => (m[a.reason] = (m[a.reason] ?? 0) + 1, m), {}))}（模型连续拒绝后由扩展直接执行）`);
  const stale = decisions.filter(e => e.state?.hints && Object.keys(e.state.hints).length).length;
  if (stale) console.log(`带「历史参考 / 老选项降级」提示的决策：${stale} 次`);
  const low = decisions.filter(e => Object.values(e.groups ?? {}).every(g => g.choice === 'wait')).length;
  console.log(`\n全部选择等待的决策：${low} / ${decisions.length}（${pct(low, decisions.length)}）`);
  const first = decisions[0];
  if (first) { console.log('\n首条决策样例：'); for (const [id, g] of Object.entries(first.groups)) console.log(`  ${id}: ${g.choice} (${g.confidence}) ← ${Object.keys(g.options).join(' | ')}`); }
} else {
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const groups = {};
  let latency = 0, allWait = 0;
  for (const r of rows) {
    let everyWait = true;
    latency += r.latency_ms ?? 0;
    for (const [id, q] of Object.entries(r.questions ?? {})) {
      const g = groups[id] ??= { asked: 0, waits: 0, options: 0, confidence: 0, choices: {} };
      g.asked++; g.options += (q.options ?? []).length; g.confidence += q.confidence ?? 0;
      if (q.choice === 'wait') g.waits++; else everyWait = false;
      g.choices[q.choice] = (g.choices[q.choice] ?? 0) + 1;
    }
    if (everyWait && Object.keys(r.questions ?? {}).length) allWait++;
  }
  console.log(`本地服务日志 ${file}`);
  console.log(`请求 ${rows.length} 次 · 平均耗时 ${rows.length ? Math.round(latency / rows.length) : '—'} ms · 时间 ${rows[0]?.at ?? '?'} → ${rows.at(-1)?.at ?? '?'}`);
  console.log(`全部选择等待的请求：${allWait} / ${rows.length}（${pct(allWait, rows.length)}）`);
  console.log('\n各决策组：');
  for (const [id, g] of Object.entries(groups)) {
    const choices = Object.fromEntries(Object.entries(g.choices).sort(([, a], [, b]) => b - a).slice(0, 6));
    console.log(`  ${id.padEnd(13)} 问 ${String(g.asked).padStart(4)} 次 · 等待率 ${pct(g.waits, g.asked).padStart(4)} · 平均候选 ${(g.options / g.asked).toFixed(1)} · 置信 ${(g.confidence / g.asked).toFixed(2)} · 常选：${list(choices)}`);
  }
}

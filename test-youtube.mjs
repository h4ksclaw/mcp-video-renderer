#!/usr/bin/env node
const MCP_URL = 'http://localhost:3100/mcp';
let sid = null, tests = [];

async function mcp(method, params = {}) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) };
  const r = await fetch(MCP_URL, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  sid = r.headers.get('mcp-session-id') || sid;
  const lines = r.text ? await r.text() : await r.text();
  const evts = [];
  for (const l of lines.split('\n')) { if (l.startsWith('data: ')) try { evts.push(JSON.parse(l.slice(6))); } catch {} }
  for (let i = evts.length - 1; i >= 0; i--) { if (evts[i]?.result?.content?.length) return evts[i].result; if (evts[i]?.error) return evts[i]; }
  return evts[0] || {};
}

async function test(name, tool, args) {
  process.stdout.write(`  ${name}... `);
  try {
    const r = await mcp('tools/call', { name: tool, arguments: args });
    if (r?.error) { process.stdout.write(`FAIL\n    ${JSON.stringify(r.error).slice(0,150)}\n`); tests.push({name,pass:false,error:JSON.stringify(r.error)}); return null; }
    if (r?.isError) { const e = r.content?.[0]?.text||''; process.stdout.write(`FAIL\n    ${e.slice(0,150)}\n`); tests.push({name,pass:false,error:e}); return null; }
    const t = r.content?.[0]?.text || '';
    process.stdout.write(`OK\n`);
    tests.push({name,pass:true});
    try { return JSON.parse(t); } catch { return t; }
  } catch(e) { process.stdout.write(`FAIL\n    ${e.message.slice(0,150)}\n`); tests.push({name,pass:false,error:e.message}); return null; }
}

async function main() {
  console.log('=== YouTube Tools Test ===\n');
  await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '3' } });

  // List tools
  const tl = await mcp('tools/list', {});
  console.log(`Tools (${tl?.tools?.length}): ${(tl?.tools||[]).map(t=>t.name).join(', ')}`);

  // 1. video_info
  console.log('\n--- video_info ---');
  const info = await test('Video info (Big Buck Bunny)', 'video_info', { url: 'YE7VzlLtp-4' });
  if (info && typeof info === 'object') {
    console.log(`    Title: ${info.title}`);
    console.log(`    Channel: ${info.channel} (verified: ${info.channel_verified}, subs: ${(info.channel_subscribers||0).toLocaleString()})`);
    console.log(`    Duration: ${info.duration} (${info.duration_seconds}s)`);
    console.log(`    Views: ${(info.views||0).toLocaleString()} | Likes: ${(info.likes||0).toLocaleString()}`);
    console.log(`    Tags: ${(info.tags||[]).slice(0,5).join(', ')}`);
    console.log(`    Heatmap peaks: ${JSON.stringify(info.heatmap_peaks||[])}`);
    console.log(`    Subtitles: ${Object.keys(info.subtitles||{}).slice(0,5).join(', ')}...`);
    console.log(`    Thumbnails: ${(info.thumbnails||[]).length} available`);
  }

  // 2. search_videos
  console.log('\n--- search_videos ---');
  const search = await test('Search "lofi hip hop radio"', 'search_videos', { query: 'lofi hip hop radio', max_results: 3 });
  if (Array.isArray(search)) {
    search.forEach((v, i) => console.log(`    ${i+1}. [${v.id}] ${v.title} (${v.duration}, ${(v.views||0).toLocaleString()} views) — ${v.channel}`));
  }

  // 3. get_subtitles
  console.log('\n--- get_subtitles ---');
  const subs = await test('Get English auto-subs', 'get_subtitles', { url: 'YE7VzlLtp-4', lang: 'en', auto: true });
  if (typeof subs === 'string') {
    const lines = subs.split('\n').filter(l => l.trim());
    console.log(`    Got ${lines.length} lines`);
    const textLines = lines.filter(l => /^\d+$/.test(l.trim()) === false && !l.includes('-->'));
    console.log(`    First 3 text lines: ${textLines.slice(0,3).map(l=>l.trim()).join(' | ')}`);
  }

  // 4. get_thumbnail
  console.log('\n--- get_thumbnail ---');
  const thumb = await test('Get thumbnail (1280px)', 'get_thumbnail', { url: 'YE7VzlLtp-4', max_width: 1280 });
  if (thumb && typeof thumb === 'object') {
    console.log(`    media_id: ${thumb.media_id} | ${thumb.filename} | ${thumb.width}x${thumb.height} | ${thumb.size} bytes`);
  }

  // Summary
  console.log('\n============================');
  const p = tests.filter(t=>t.pass).length, f = tests.filter(t=>!t.pass).length;
  console.log(`  ${p}/${tests.length} passed, ${f} failed`);
  if (f) tests.filter(t=>!t.pass).forEach(t => console.log(`    ✗ ${t.name}: ${(t.error||'').slice(0,120)}`));
  process.exit(f ? 1 : 0);
}
main().catch(e => { console.error('Fatal:', e); process.exit(2); });

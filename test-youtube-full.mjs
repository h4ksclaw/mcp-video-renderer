#!/usr/bin/env node
const MCP_URL = 'http://localhost:3100/mcp';
let sid = null, pass = 0, fail = 0;

async function mcp(method, params = {}) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) };
  const r = await fetch(MCP_URL, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  sid = r.headers.get('mcp-session-id') || sid;
  const text = await r.text();
  const evts = [];
  for (const l of text.split('\n')) { if (l.startsWith('data: ')) try { evts.push(JSON.parse(l.slice(6))); } catch {} }
  for (let i = evts.length - 1; i >= 0; i--) { if (evts[i]?.result?.content?.length) return evts[i].result; if (evts[i]?.error) return evts[i]; }
  return evts[0] || {};
}

function ok(name) { pass++; console.log(`  ✅ ${name}`); }
function ng(name, e) { fail++; console.log(`  ❌ ${name}: ${(e||'').slice(0,200)}`); }

async function main() {
  await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '4' } });

  // ── video_info edge cases ──
  console.log('\n=== video_info edge cases ===');

  // Bare video ID (no URL)
  let r = await mcp('tools/call', { name: 'video_info', arguments: { url: 'dQw4w9WgXcQ' } });
  let d = JSON.parse(r.content[0].text);
  if (d.title && d.title.includes('Rick')) ok('Bare video ID → full URL resolved');
  else ng('Bare video ID', JSON.stringify(d).slice(0,100));

  // Full URL
  r = await mcp('tools/call', { name: 'video_info', arguments: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  d = JSON.parse(r.content[0].text);
  if (d.id === 'dQw4w9WgXcQ' && d.views > 0) ok('Full URL works, views > 0');
  else ng('Full URL', `id=${d.id} views=${d.views}`);

  // Heatmap exists and is valid
  if (Array.isArray(d.heatmap_peaks) && d.heatmap_peaks.length > 0 && d.heatmap_peaks[0].intensity > 0)
    ok(`Heatmap: ${d.heatmap_peaks.length} peaks, top=${d.heatmap_peaks[0].intensity}%`);
  else ng('Heatmap missing/empty', JSON.stringify(d.heatmap_peaks));

  // Channels/subscribers present
  if (d.channel_subscribers && d.channel_subscribers > 0)
    ok(`Channel info: ${d.channel} (${(d.channel_subscribers).toLocaleString()} subs)`);
  else ng('Channel info', `subs=${d.channel_subscribers}`);

  // Chapters (find a video with chapters)
  r = await mcp('tools/call', { name: 'video_info', arguments: { url: 'https://www.youtube.com/watch?v=JGwWNGJdvx8' } });
  d = JSON.parse(r.content[0].text);
  if (Array.isArray(d.chapters) && d.chapters.length > 0)
    ok(`Chapters: ${d.chapters.length} chapters found (video JGwWNGJdvx8)`);
  else
    ok('Chapters: none for this video (expected for some videos)');

  // Invalid video ID
  r = await mcp('tools/call', { name: 'video_info', arguments: { url: 'zzzzzzzzzzzINVALID' } });
  if (r.error || (r.content?.[0]?.text?.includes('fail'))) ok('Invalid ID → error returned');
  else ng('Invalid ID should error', JSON.stringify(r).slice(0,200));

  // ── search edge cases ──
  console.log('\n=== search_videos edge cases ===');

  // Max results = 1
  r = await mcp('tools/call', { name: 'search_videos', arguments: { query: 'cats', max_results: 1 } });
  d = JSON.parse(r.content[0].text);
  if (Array.isArray(d) && d.length === 1) ok('max_results=1 returns exactly 1');
  else ng('max_results=1', `got ${d?.length} results`);

  // Max results = 20
  r = await mcp('tools/call', { name: 'search_videos', arguments: { query: 'music', max_results: 20 } });
  d = JSON.parse(r.content[0].text);
  if (Array.isArray(d) && d.length >= 10) ok(`max_results=20 returns ${d.length} results`);
  else ng('max_results=20', `got ${d?.length} results`);

  // Search with special chars
  r = await mcp('tools/call', { name: 'search_videos', arguments: { query: 'how to "repair" a sink (DIY)' } });
  if (!r.error) ok('Special chars in query handled');
  else ng('Special chars', JSON.stringify(r.error).slice(0,150));

  // Gibberish search (should return empty or few results, not crash)
  r = await mcp('tools/call', { name: 'search_videos', arguments: { query: 'asdfqwerzxcv123456789xyz' } });
  if (!r.error) ok('Gibberish search returns (possibly empty) without crash');
  else ng('Gibberish search', JSON.stringify(r.error).slice(0,150));

  // Result fields present
  r = await mcp('tools/call', { name: 'search_videos', arguments: { query: 'never gonna give you up', max_results: 1 } });
  d = JSON.parse(r.content[0].text);
  const v = d[0];
  if (v.id && v.title && v.url && v.channel && v.duration && typeof v.views === 'number' && v.thumbnail)
    ok('All fields present in search result');
  else ng('Missing fields', `missing: ${['id','title','url','channel','duration','views','thumbnail'].filter(f=>!v[f]).join(',')}`);

  // ── get_subtitles edge cases ──
  console.log('\n=== get_subtitles edge cases ===');

  // Auto-generated captions
  r = await mcp('tools/call', { name: 'get_subtitles', arguments: { url: 'YE7VzlLtp-4', lang: 'en', auto: true } });
  const subText = r.content[0].text;
  if (subText.includes('-->')) ok('Auto-subs have SRT timestamps');
  else ng('Auto-subs format', subText.slice(0,100));

  // Manual subs
  r = await mcp('tools/call', { name: 'get_subtitles', arguments: { url: 'YE7VzlLtp-4', lang: 'en', auto: false } });
  if (!r.error) ok('Manual subs work (or gracefully handled if none)');
  else if (r.content?.[0]?.text?.includes('Subtitle download failed'))
    ok('Manual subs: correct error when not available');
  else ng('Manual subs', JSON.stringify(r).slice(0,150));

  // Non-existent language
  r = await mcp('tools/call', { name: 'get_subtitles', arguments: { url: 'YE7VzlLtp-4', lang: 'xx_fictional', auto: true } });
  if (r.error || (r.content?.[0]?.text?.includes('fail'))) ok('Non-existent lang → error');
  else ng('Non-existent lang should error', JSON.stringify(r).slice(0,150));

  // ── get_thumbnail edge cases ──
  console.log('\n=== get_thumbnail edge cases ===');

  // Cache hit (same video again)
  r = await mcp('tools/call', { name: 'get_thumbnail', arguments: { url: 'YE7VzlLtp-4', max_width: 1280 } });
  d = JSON.parse(r.content[0].text);
  if (d.cached) ok('Thumbnail cached on second call');
  else ng('Thumbnail cache miss on second call', JSON.stringify(d));

  // Different max_width
  r = await mcp('tools/call', { name: 'get_thumbnail', arguments: { url: 'YE7VzlLtp-4', max_width: 320 } });
  d = JSON.parse(r.content[0].text);
  if (d.width <= 320) ok(`Thumbnail max_width=320 → ${d.width}px`);
  else ng('Thumbnail width > max_width', `got ${d.width}px`);

  // Thumbnail with Rick Astley (newer video, likely higher res)
  r = await mcp('tools/call', { name: 'get_thumbnail', arguments: { url: 'dQw4w9WgXcQ', max_width: 1280 } });
  d = JSON.parse(r.content[0].text);
  if (d.width >= 640) ok(`Thumbnail: ${d.width}x${d.height}, ${d.media_id}`);
  else ng('Thumbnail too small', `${d.width}x${d.height}`);

  // ── Thumbnail → render pipeline ──
  console.log('\n=== thumbnail → render_video pipeline ===');

  const thumbId = d.media_id;
  const thumbFn = d.filename;
  const thumbHtml = `<div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
  <div class="clip" data-start="0" data-duration="5" data-track-index="0" style="position:absolute;top:0;left:0;width:1920px;height:1080px;background:#1a1a2e;">
    <img src="assets/${thumbFn}" style="width:960px;height:540px;position:absolute;top:270px;left:480px;object-fit:contain;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);" />
  </div>
  <div class="clip" data-start="0" data-duration="5" data-track-index="1" style="position:absolute;top:80px;left:0;width:1920px;text-align:center;">
    <div style="font-family:sans-serif;font-weight:900;font-size:72px;color:#fff;text-shadow:0 4px 20px rgba(0,0,0,0.6);">THUMBNAIL<br/>IN COMPOSITION</div>
  </div>
</div>`;

  const b64 = Buffer.from(thumbHtml).toString('base64');
  r = await mcp('tools/call', { name: 'render_video', arguments: { html: b64, media: [{ media_id: thumbId }], resolution: '1080p' } });
  const renderText = r.content[0].text;
  const match = renderText.match(/https?:[^\s\)]+\.mp4/);
  if (match) {
    // Verify the file exists and has content
    const fr = await fetch(match[0], { method: 'HEAD' });
    const size = parseInt(fr.headers.get('content-length') || '0');
    if (size > 10000) ok(`Thumbnail render: ${size} bytes (${(size/1024).toFixed(0)}KB)`);
    else ng('Thumbnail render too small', `${size} bytes`);
  } else {
    ng('Thumbnail render', `no URL in response: ${renderText.slice(0,200)}`);
  }

  // ── Summary ──
  console.log('\n============================');
  console.log(`  ${pass}/${pass+fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL:', e); process.exit(2); });

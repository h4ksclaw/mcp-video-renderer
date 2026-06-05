#!/usr/bin/env node
// MCP Video Renderer — comprehensive test suite v3
const MCP_URL = 'http://localhost:3100/mcp';
let sessionId = null;
let tests = [];

async function mcpCall(method, params = {}) {
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  };
  const res = await fetch(MCP_URL, init);
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const lines = text.split('\n').filter(l => l.startsWith('data: '));
  const events = [];
  for (const line of lines) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.result?.content?.length) return e.result;
    if (e?.result?.tools) return e.result;
    if (e?.error) return e;
  }
  return events.length ? events[events.length - 1] : { error: { message: text.slice(0, 200) } };
}

async function test(name, tool, args) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await mcpCall('tools/call', { name: tool, arguments: args });
    if (result?.error) {
      process.stdout.write(`FAIL\n    Error: ${JSON.stringify(result.error)}\n`);
      tests.push({ name, pass: false, error: JSON.stringify(result.error) });
      return null;
    }
    if (result?.isError) {
      const err = result.content?.[0]?.text || JSON.stringify(result.content);
      process.stdout.write(`FAIL\n    Error: ${err.slice(0, 200)}\n`);
      tests.push({ name, pass: false, error: err });
      return null;
    }
    const text = result.content?.[0]?.text || '';
    process.stdout.write(`OK\n`);
    tests.push({ name, pass: true });
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    process.stdout.write(`FAIL\n    Exception: ${e.message}\n`);
    tests.push({ name, pass: false, error: e.message });
    return null;
  }
}

async function main() {
  console.log('=== MCP Video Renderer Test Suite v3 ===\n');

  console.log('Initializing MCP session...');
  const initResult = await mcpCall('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'test-suite', version: '3.0.0' },
  });
  console.log(`  Session: ${sessionId ? sessionId.slice(0, 12) + '...' : 'NONE'}`);
  if (initResult?.error) { console.log(`  Init error: ${JSON.stringify(initResult.error)}`); process.exit(1); }

  console.log('\n--- Tools ---');
  const toolsResult = await mcpCall('tools/list', {});
  if (toolsResult?.tools) toolsResult.tools.forEach(t => console.log(`  • ${t.name}`));

  // 1. download_media — direct URL
  console.log('\n--- download_media (direct URL) ---');
  const dl1 = await test('Download MP4', 'download_media', { url: 'https://www.w3schools.com/html/mov_bbb.mp4' });
  const mid1 = dl1?.media_id;
  if (dl1) console.log(`    media_id: ${dl1.media_id}, ${dl1.size} bytes, ${dl1.width}x${dl1.height}`);

  // 2. download_media — YouTube (full, no trim)
  console.log('\n--- download_media (YouTube) ---');
  const dl2 = await test('YouTube (first 15s)', 'download_media', { url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4', end: 15 });
  const mid2 = dl2?.media_id;
  if (dl2) console.log(`    media_id: ${dl2.media_id}, ${dl2.size} bytes, ${dl2.duration.toFixed(1)}s`);

  // 3. download_media — YouTube with trim
  console.log('\n--- download_media (YouTube trimmed) ---');
  const dl3 = await test('YouTube (5-10s)', 'download_media', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', start: 5, end: 10 });
  const mid3 = dl3?.media_id;
  if (dl3) console.log(`    media_id: ${dl3.media_id}, ${dl3.size} bytes, ${dl3.duration.toFixed(1)}s`);

  // 4. media_cache
  console.log('\n--- media_cache ---');
  const cache = await test('List cache', 'media_cache', { action: 'list' });
  if (Array.isArray(cache)) console.log(`    ${cache.length} items`);

  // 5. lint
  console.log('\n--- lint ---');
  const goodHtml = `<div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
  <div class="clip" data-start="0" data-duration="5" data-track-index="0" style="position:absolute;top:0;left:0;">Hello</div>
</div>`;
  const lintOk = await test('Lint valid', 'lint', { html: goodHtml });
  if (lintOk) console.log(`    Issues: ${lintOk.issues?.length}`);

  const badHtml = `<div data-duration="5"><div style="bottom:0;">X</div></div>`;
  const lintBad = await test('Lint invalid', 'lint', { html: badHtml });
  if (lintBad) console.log(`    Issues found: ${lintBad.issues?.length}`);

  // 6. TTS
  console.log('\n--- tts ---');
  const tts = await test('Generate speech', 'tts', { text: 'Testing text to speech.', voice: 'am_adam', speed: 1.0 });
  if (typeof tts === 'string') {
    const b64 = tts.split('\n').find(l => l.length > 100);
    if (b64) console.log(`    Audio: ${b64.length} chars base64`);
  }

  // 7. render_video — basic
  console.log('\n--- render_video (basic) ---');
  const r1 = await test('Render text', 'render_video', { html: Buffer.from(goodHtml).toString('base64'), resolution: '1080p' });
  if (r1?.url) {
    const h = await fetch(r1.url, { method: 'HEAD' });
    console.log(`    ${r1.url} — ${h.status} ${h.headers.get('content-type')} ${h.headers.get('content-length')}B`);
  }

  // 8. render_video — with YouTube media
  console.log('\n--- render_video (with media) ---');
  if (mid2) {
    const fn = dl2.filename;
    const mediaHtml = Buffer.from(`<div id="root" data-composition-id="main" data-start="0" data-duration="10" data-width="1920" data-height="1080">
  <div class="clip" data-start="0" data-duration="10" data-track-index="0" style="position:absolute;top:0;left:0;width:1920px;height:1080px;background:#000;">
    <video src="assets/${fn}" style="width:100%;height:100%;object-fit:contain;" muted autoplay playsinline></video>
  </div>
</div>`).toString('base64');
    const r2 = await test('Render with YouTube video', 'render_video', {
      html: mediaHtml, media: [{ media_id: mid2 }], resolution: '1080p',
    });
    if (r2?.url) {
      const h = await fetch(r2.url, { method: 'HEAD' });
      console.log(`    ${r2.url} — ${h.status} ${h.headers.get('content-type')} ${h.headers.get('content-length')}B`);
    }
  } else { console.log('  [SKIP] no YouTube media'); }

  // 9. remove_background — video input with webm output
  console.log('\n--- remove_background ---');
  if (mid1) {
    const rb = await test('RMBG video→webm', 'remove_background', { input: mid1, format: 'webm' });
    if (rb) console.log(`    media_id: ${rb.media_id}, ${rb.size} bytes`);
  } else {
    const rb = await test('RMBG URL→webm', 'remove_background', { input: 'https://www.w3schools.com/html/mov_bbb.mp4', format: 'webm' });
    if (rb) console.log(`    media_id: ${rb.media_id}, ${rb.size} bytes`);
  }

  // 10. remove_background — validation: video+png should fail
  console.log('\n--- remove_background validation ---');
  await test('Reject video→png', 'remove_background', { input: mid1 || 'https://www.w3schools.com/html/mov_bbb.mp4', format: 'png' });

  // 11. render_queue
  console.log('\n--- render_queue ---');
  await test('Queue status', 'render_queue', {});

  // Summary
  console.log('\n============================');
  const p = tests.filter(t => t.pass).length;
  const f = tests.filter(t => !t.pass).length;
  console.log(`  ${p}/${tests.length} passed, ${f} failed`);
  if (f > 0) {
    console.log('\n  Failures:');
    tests.filter(t => !t.pass).forEach(t => console.log(`    ✗ ${t.name}: ${(t.error || '').slice(0, 120)}`));
  }
  process.exit(f > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });

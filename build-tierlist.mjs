#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';

const YTDLP = '/var/lib/hermes/.hermes/hermes-agent/venv/bin/yt-dlp';
const MCP = 'http://localhost:3100/mcp';
let sid = null;

async function mcpCall(method, params = {}) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) };
  const r = await fetch(MCP, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  sid = r.headers.get('mcp-session-id') || sid;
  const text = await r.text();
  const evts = [];
  for (const l of text.split('\n')) { if (l.startsWith('data: ')) try { evts.push(JSON.parse(l.slice(6))); } catch {} }
  for (let i = evts.length - 1; i >= 0; i--) { if (evts[i]?.result?.content?.length) return evts[i].result; if (evts[i]?.error) return evts[i]; }
  return evts[0] || {};
}

function ytDlpJson(...args) {
  const env = { ...process.env, PATH: '/var/lib/hermes/.deno/bin:' + process.env.PATH };
  const result = execFileSync(YTDLP, args, { encoding: 'utf-8', timeout: 60000, maxBuffer: 50 * 1024 * 1024, env });
  return JSON.parse(result.trim());
}

function ytDlpJsonMulti(...args) {
  const env = { ...process.env, PATH: '/var/lib/hermes/.deno/bin:' + process.env.PATH };
  const result = execFileSync(YTDLP, args, { encoding: 'utf-8', timeout: 60000, maxBuffer: 50 * 1024 * 1024, env });
  return result.trim().split('\n').filter(l => l).map(l => JSON.parse(l));
}

// Verified trailer video IDs (searched via ytsearch)
const games = [
  { name: 'GTA VI', id: 'QdBZY2fkU-0', color: '#10b981', release: 'Fall 2026', dev: 'Rockstar Games' },
  { name: 'Monster Hunter Wilds', id: 'a_wNFT4j6qI', color: '#f97316', release: 'Feb 28 2026', dev: 'Capcom' },
  { name: 'Ghost of Yōtei', id: '7z7kqwuf0a8', color: '#a855f7', release: '2026', dev: 'Sucker Punch' },
  { name: 'Doom: The Dark Ages', id: '4tk8lkmYGWQ', color: '#dc2626', release: 'May 15 2025', dev: 'id Software' },
  { name: 'Death Stranding 2', id: 'eT_A2gPhTIw', color: '#3b82f6', release: 'June 2025', dev: 'Kojima Productions' },
];

console.log('=== PHASE 1: Initialize MCP ===\n');
await mcpCall('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tierlist', version: '1' } });
console.log('MCP session initialized');

console.log('\n=== PHASE 2: Get video info + heatmaps ===\n');
const trailerData = [];

for (const game of games) {
  console.log(`Fetching: ${game.name}`);
  const d = ytDlpJson('--dump-json', '--no-download', `https://youtube.com/watch?v=${game.id}`);
  const hm = d.heatmap || [];
  
  // Find top 3 content peaks (skip first 3s which is always 100%)
  const contentPeaks = [...hm].sort((a, b) => b.value - a.value).filter(h => h.start_time > 3);
  const peaks = contentPeaks.slice(0, 3).map(h => ({
    start: Math.round(h.start_time),
    end: Math.round(h.end_time),
    intensity: +(h.value * 100).toFixed(1),
  }));
  
  console.log(`  ${d.title.slice(0, 60)} | ${(d.view_count || 0).toLocaleString()} views | ${Math.round(d.duration)}s`);
  console.log(`  Peaks: ${peaks.length > 0 ? peaks.map(p => `${p.start}s (${p.intensity}%)`).join(', ') : 'none'}`);
  
  trailerData.push({
    ...game,
    title: d.title,
    views: d.view_count || 0,
    duration: d.duration,
    peaks,
    videoUrl: `https://youtube.com/watch?v=${game.id}`,
  });
}

console.log('\n=== PHASE 2: Download clips from peak segments ===\n');
const clips = [];

for (const t of trailerData) {
  const peak = t.peaks[0];
  const start = peak ? peak.start : 5;
  const end = Math.min(start + 8, t.duration);
  console.log(`${t.name}: downloading ${start}s-${end}s`);
  
  const r = await mcpCall('tools/call', {
    name: 'download_media',
    arguments: { url: t.videoUrl, start, end },
  });
  
  try {
    const d = JSON.parse(r.content[0].text);
    console.log(`  → ${d.media_id} (${(d.size/1024).toFixed(0)}KB, ${d.duration}s)`);
    clips.push({ media_id: d.media_id, filename: d.filename, ...t, clipStart: start, clipEnd: end });
  } catch(e) {
    console.log(`  ❌ ${r.content?.[0]?.text?.slice(0,120)}`);
  }
}

console.log(`\nGot ${clips.length}/5 clips`);

console.log('\n=== PHASE 3: Build + render composition (SINGLE CALL) ===\n');

const segDur = 8;
const totalDur = segDur * clips.length;
let tracks = [];
let scripts = [];

// BG
tracks.push(`<div class="clip" data-start="0" data-duration="${totalDur}" data-track-index="0" style="position:absolute;top:0;left:0;width:1920;height:1080;background:linear-gradient(145deg,#050510 0%,#0f0f2e 40%,#0a0a1a 100%);"></div>`);

// Scanlines
tracks.push(`<div class="clip" data-start="0" data-duration="${totalDur}" data-track-index="1" style="position:absolute;top:0;left:0;width:1920;height:1080;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(255,255,255,0.015) 2px,rgba(255,255,255,0.015) 4px);pointer-events:none;"></div>`);

// Title
tracks.push(`<div class="clip" data-start="0" data-duration="${segDur}" data-track-index="2" id="main-title" style="position:absolute;top:30px;left:0;width:1920;text-align:center;opacity:0;">
  <div style="font-family:sans-serif;font-weight:900;font-size:52px;color:#fff;letter-spacing:6px;text-shadow:0 4px 30px rgba(0,0,0,0.9);">MOST ANTICIPATED GAMES OF 2026</div>
  <div style="font-family:sans-serif;font-weight:400;font-size:18px;color:rgba(255,255,255,0.35);letter-spacing:10px;margin-top:6px;">YOUTUBE HEATMAP ANALYTICS • TRAILER REPLAY DATA</div>
</div>`);

scripts.push(`tl["main"].to("#main-title", { opacity: 1 }, 0.6, 0.2);`);

for (let i = 0; i < clips.length; i++) {
  const c = clips[i];
  const segStart = i * segDur;
  const peak = c.peaks[0] || { intensity: 0 };
  const heatPct = peak.intensity;
  
  // Rank number watermark
  tracks.push(`<div class="clip" data-start="${segStart}" data-duration="${segDur}" data-track-index="${10+i}" id="rank-${i}" style="position:absolute;left:40px;top:140px;opacity:0;">
    <div style="font-family:sans-serif;font-weight:900;font-size:240px;color:${c.color};opacity:0.08;line-height:1;">${i+1}</div>
  </div>`);
  scripts.push(`tl["main"].to("#rank-${i}", { opacity: 1 }, 0.3, ${segStart+0.1});`);

  // Video clip with glow border
  tracks.push(`<div class="clip" data-start="${segStart}" data-duration="${segDur}" data-track-index="${20+i}" id="vid-${i}" style="position:absolute;top:170px;left:60px;width:700px;height:394px;border-radius:12px;overflow:hidden;opacity:0;box-shadow:0 0 40px ${c.color}44, 0 8px 32px rgba(0,0,0,0.7);">
    <video src="assets/${c.filename}" style="width:100%;height:100%;object-fit:cover;" muted autoplay playsinline loop></video>
  </div>`);
  scripts.push(`tl["main"].to("#vid-${i}", { opacity: 1, scale: 1 }, 0.4, ${segStart+0.2});`);
  scripts.push(`tl["main"].from("#vid-${i}", { scale: 1.05 }, 0.4, ${segStart+0.2});`);

  // Heat indicator bar
  tracks.push(`<div class="clip" data-start="${segStart}" data-duration="${segDur}" data-track-index="${30+i}" id="heat-${i}" style="position:absolute;top:568px;left:60px;width:0;height:4px;background:${c.color};border-radius:2px;opacity:0;"></div>`);
  scripts.push(`tl["main"].to("#heat-${i}", { width: ${Math.round(700 * heatPct / 100)}, opacity: 1 }, 0.8, ${segStart+0.5});`);

  // Game info panel (right)
  tracks.push(`<div class="clip" data-start="${segStart}" data-duration="${segDur}" data-track-index="${40+i}" id="info-${i}" style="position:absolute;top:170px;left:820px;width:1040px;opacity:0;">
    <div style="font-family:sans-serif;font-weight:900;font-size:62px;color:#fff;line-height:1.05;text-shadow:0 2px 16px rgba(0,0,0,0.6);">${c.name}</div>
    <div style="font-family:sans-serif;font-weight:600;font-size:22px;color:${c.color};letter-spacing:2px;margin-top:6px;">${c.dev}</div>
    <div style="font-family:sans-serif;font-size:18px;color:rgba(255,255,255,0.4);margin-top:4px;">${c.release}</div>
    
    <div style="margin-top:20px;display:flex;gap:16px;">
      <div style="background:rgba(255,255,255,0.06);border-radius:8px;padding:12px 22px;">
        <div style="font-family:sans-serif;font-size:12px;color:rgba(255,255,255,0.4);letter-spacing:2px;">TRAILER VIEWS</div>
        <div style="font-family:sans-serif;font-weight:700;font-size:26px;color:#fff;">${(c.views).toLocaleString()}</div>
      </div>
      <div style="background:rgba(255,255,255,0.06);border-radius:8px;padding:12px 22px;">
        <div style="font-family:sans-serif;font-size:12px;color:rgba(255,255,255,0.4);letter-spacing:2px;">PEAK MOMENT</div>
        <div style="font-family:sans-serif;font-weight:700;font-size:26px;color:${c.color};">${peak.start || 0}s</div>
      </div>
      <div style="background:rgba(255,255,255,0.06);border-radius:8px;padding:12px 22px;">
        <div style="font-family:sans-serif;font-size:12px;color:rgba(255,255,255,0.4);letter-spacing:2px;">HEAT INDEX</div>
        <div style="font-family:sans-serif;font-weight:700;font-size:26px;color:#fff;">${heatPct}%</div>
      </div>
    </div>
    
    <div style="margin-top:16px;">
      <div style="font-family:sans-serif;font-size:12px;color:rgba(255,255,255,0.3);letter-spacing:1px;">TOP REPLAYED SEGMENTS</div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        ${c.peaks.slice(0,3).map(p => `<div style="background:rgba(255,255,255,0.05);border:1px solid ${c.color}33;border-radius:6px;padding:5px 14px;font-family:monospace;font-size:14px;color:rgba(255,255,255,0.6);">${Math.floor(p.start/60)}:${String(p.start%60).padStart(2,'0')} — ${p.intensity}%</div>`).join('')}
      </div>
    </div>
  </div>`);
  scripts.push(`tl["main"].to("#info-${i}", { opacity: 1 }, 0.4, ${segStart+0.3});`);

  // Heat bar mini visualization
  tracks.push(`<div class="clip" data-start="${segStart}" data-duration="${segDur}" data-track-index="${50+i}" id="bars-${i}" style="position:absolute;top:620px;left:820px;width:1040px;opacity:0;">
    <div style="display:flex;gap:2px;align-items:flex-end;height:40px;">
      ${c.peaks.slice(0,3).map(p => {
        const h = Math.round(40 * p.intensity / 100);
        return `<div style="width:${Math.round(1040/3 - 4)}px;height:${Math.max(4, h)}px;background:${c.color};border-radius:3px;opacity:0.7;"></div>`;
      }).join('')}
    </div>
  </div>`);
  scripts.push(`tl["main"].to("#bars-${i}", { opacity: 1 }, 0.3, ${segStart+0.8});`);

  // Fade out previous
  if (i > 0) {
    const p = i - 1;
    scripts.push(`tl["main"].to("#rank-${p}", { opacity: 0 }, 0.25, ${segStart});`);
    scripts.push(`tl["main"].to("#vid-${p}", { opacity: 0 }, 0.25, ${segStart});`);
    scripts.push(`tl["main"].to("#heat-${p}", { width: 0, opacity: 0 }, 0.25, ${segStart});`);
    scripts.push(`tl["main"].to("#info-${p}", { opacity: 0 }, 0.25, ${segStart});`);
    scripts.push(`tl["main"].to("#bars-${p}", { opacity: 0 }, 0.25, ${segStart});`);
  }
}

// Divider lines between segments
for (let i = 0; i < clips.length - 1; i++) {
  const segStart = i * segDur;
  tracks.push(`<div class="clip" data-start="${segStart}" data-duration="${segDur}" data-track-index="${60+i}" style="position:absolute;bottom:50px;left:60px;right:60px;height:1px;background:rgba(255,255,255,0.06);"></div>`);
}

// Bottom watermark
tracks.push(`<div class="clip" data-start="0" data-duration="${totalDur}" data-track-index="99" style="position:absolute;bottom:18px;left:60px;">
  <div style="font-family:monospace;font-size:13px;color:rgba(255,255,255,0.2);">DATA: YOUTUBE HEATMAP ANALYTICS • MCP VIDEO RENDERER</div>
</div>`);

// Number indicator right
tracks.push(`<div class="clip" data-start="0" data-duration="${totalDur}" data-track-index="98" style="position:absolute;bottom:18px;right:60px;">
  <div style="font-family:monospace;font-size:13px;color:rgba(255,255,255,0.2);">${clips.length}/5 GAMES</div>
</div>`);

const html = `<div id="root" data-composition-id="main" data-start="0" data-duration="${totalDur}" data-width="1920" data-height="1080">\n${tracks.join('\n')}\n</div>\n<script>\nconst tl = window.__timelines = {};\ntl["main"] = gsap.timeline({ paused: true });\n${scripts.join('\n')}\n</script>`;

fs.writeFileSync('/tmp/tierlist-comp.html', html);
console.log(`Composition: ${totalDur}s, ${clips.length} games, ${(html.length/1024).toFixed(1)}KB`);

console.log(`\nCalling render_video (SINGLE CALL) with ${clips.length} media IDs...`);
const b64 = Buffer.from(html).toString('base64');
const r = await mcpCall('tools/call', {
  name: 'render_video',
  arguments: { html: b64, media: clips.map(c => ({ media_id: c.media_id })), resolution: '1080p', fps: 30 },
});

const txt = r.content[0].text;
const url = txt.match(/https?:[^\s\)]+\.mp4/)?.[0];
if (url) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-print_format','json','-show_format','-show_streams',url], { encoding: 'utf-8' }));
  const v = probe.streams.find(s => s.codec_type === 'video');
  const f = probe.format;
  console.log(`\n✅ RENDERED — SINGLE CALL`);
  console.log(`   ${v.width}x${v.height} H.264 @ ${v.r_frame_rate}fps`);
  console.log(`   ${parseFloat(f.duration).toFixed(1)}s, ${(parseInt(f.size)/1024/1024).toFixed(1)} MB`);
  console.log(`   ${clips.length} YouTube trailer clips with heatmap data`);
  console.log(`   URL: ${url}`);
  fs.writeFileSync('/tmp/tierlist-url.txt', url);
} else {
  console.log(`\n❌ ${txt.slice(0,300)}`);
  fs.writeFileSync('/tmp/tierlist-error.txt', txt);
}

// YouTube analytics/info tools — thin wrappers around yt-dlp
// All tools are stateless — yt-dlp does the work, we just format the output
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || '';
const CACHE_DIR = process.env.MEDIA_CACHE_DIR || join(homedir(), '.cache', 'mcp-video-renderer', 'media');

// Run command, return { stdout, stderr }
function run(cmd, args, timeout = 120) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout * 1000,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr.slice(-500) || stdout.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}

// Build common yt-dlp args (cookies, quiet)
function baseArgs() {
  const args = ['--no-download', '--dump-json'];
  if (YTDLP_COOKIES) {
    try { args.push('--cookies', YTDLP_COOKIES); } catch {}
  }
  return args;
}

/**
 * Get full video metadata including heatmap, chapters, subtitles, thumbnails.
 */
export async function getVideoInfo(url) {
  const args = [...baseArgs(), url];
  const { stdout } = await run(YTDLP_PATH, args, 60);

  // ytsearch returns multiple JSON lines
  const lines = stdout.split('\n').filter(l => l.trim());
  const entries = lines.map(l => JSON.parse(l));
  return entries.length === 1 ? entries[0] : entries;
}

/**
 * Extract readable summary from yt-dlp raw JSON
 */
export function formatVideoInfo(raw) {
  // Handle array of results (from search)
  if (Array.isArray(raw)) {
    return raw.map(r => formatVideoInfo(r));
  }

  const duration = raw.duration ? Math.round(raw.duration) : 0;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  // Formats: pick best quality per resolution
  const formats = (raw.formats || [])
    .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
    .slice(0, 5)
    .map(f => ({
      id: f.format_id,
      resolution: f.resolution || `${f.width}x${f.height}`,
      fps: f.fps || 0,
      vcodec: f.vcodec || 'none',
      acodec: f.acodec || 'none',
      filesize: f.filesize || f.filesize_approx || 0,
      ext: f.ext || '?',
    }));

  // Subtitles
  const subtitles = {};
  const manualSubs = raw.subtitles || {};
  const autoSubs = raw.automatic_captions || {};
  for (const [lang, tracks] of Object.entries(manualSubs)) {
    subtitles[lang] = { type: 'manual', formats: (tracks || []).map(t => t.ext || '?') };
  }
  for (const [lang, tracks] of Object.entries(autoSubs)) {
    if (!subtitles[lang]) {
      subtitles[lang] = { type: 'auto', formats: (tracks || []).map(t => t.ext || '?') };
    }
  }

  // Thumbnails
  const thumbnails = (raw.thumbnails || [])
    .sort((a, b) => (b.width || 0) - (a.width || 0))
    .slice(0, 5)
    .map(t => ({ url: t.url, width: t.width, height: t.height }));

  // Heatmap: normalize to top-5 peaks
  let heatPeaks = null;
  if (raw.heatmap && raw.heatmap.length > 0) {
    const sorted = [...raw.heatmap].sort((a, b) => b.value - a.value);
    heatPeaks = sorted.slice(0, 5).map(h => ({
      start: Math.round(h.start_time),
      end: Math.round(h.end_time),
      intensity: +(h.value * 100).toFixed(1),
    }));
  }

  return {
    id: raw.id,
    title: raw.title,
    url: raw.webpage_url,
    channel: raw.channel,
    channel_url: raw.channel_url,
    channel_verified: raw.channel_is_verified || false,
    channel_subscribers: raw.channel_follower_count || 0,
    duration: `${mins}:${String(secs).padStart(2, '0')}`,
    duration_seconds: duration,
    views: raw.view_count || 0,
    likes: raw.like_count || 0,
    rating: raw.average_rating || 0,
    description: (raw.description || '').slice(0, 500),
    upload_date: raw.upload_date,
    categories: raw.categories || [],
    tags: raw.tags || [],
    comment_count: raw.comment_count || 0,
    chapters: raw.chapters || null,
    heatmap_peaks: heatPeaks,
    subtitles,
    thumbnails,
    formats,
  };
}

/**
 * Download subtitles as text
 */
export async function getSubtitles(url, lang = 'en', auto = false) {
  const args = ['--skip-download', '--sub-lang', lang];
  if (auto) args.push('--write-auto-sub');
  else args.push('--write-sub');
  args.push('--sub-format', 'srt');

  // Write to temp dir
  const tmpId = randomUUID().slice(0, 8);
  const outPath = `/tmp/subs-${tmpId}`;
  args.push('-o', outPath);
  args.push(url);

  try {
    await run(YTDLP_PATH, args, 60);
  } catch (err) {
    throw new Error(`Subtitle download failed: ${err.message}`);
  }

  // Find the downloaded .srt file
  const fs = await import('node:fs/promises');
  const { readdir } = fs;
  const files = await readdir('/tmp').then(f => f.filter(x => x.startsWith(`subs-${tmpId}`) && x.endsWith('.srt')));
  if (files.length === 0) {
    // Try vtt
    const vttFiles = await readdir('/tmp').then(f => f.filter(x => x.startsWith(`subs-${tmpId}`)));
    if (vttFiles.length === 0) throw new Error(`No ${auto ? 'auto-' : ''}subtitles found for language "${lang}"`);
    const content = await fs.readFile(join('/tmp', vttFiles[0]), 'utf-8');
    await fs.unlink(join('/tmp', vttFiles[0])).catch(() => {});
    return { language: lang, auto, format: extname(vttFiles[0]).slice(1), content };
  }

  const content = await fs.readFile(join('/tmp', files[0]), 'utf-8');
  // Cleanup
  for (const f of files) await fs.unlink(join('/tmp', f)).catch(() => {});

  return { language: lang, auto, format: 'srt', content };
}

/**
 * Search YouTube
 */
export async function searchYouTube(query, maxResults = 5) {
  const args = [...baseArgs(), `ytsearch${maxResults}:${query}`];
  const { stdout } = await run(YTDLP_PATH, args, 60);

  const lines = stdout.split('\n').filter(l => l.trim());
  return lines.map(l => {
    const d = JSON.parse(l);
    const duration = d.duration ? Math.round(d.duration) : 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    return {
      id: d.id,
      title: d.title,
      url: d.webpage_url || `https://www.youtube.com/watch?v=${d.id}`,
      channel: d.channel,
      channel_url: d.channel_url,
      channel_verified: d.channel_is_verified || false,
      duration: `${mins}:${String(secs).padStart(2, '0')}`,
      duration_seconds: duration,
      views: d.view_count || 0,
      upload_date: d.upload_date,
      thumbnail: d.thumbnail || (d.thumbnails || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url,
    };
  });
}

/**
 * Download thumbnail into media cache, return media_id
 */
export async function getThumbnail(url, maxWidth = 1280) {
  await mkdir(CACHE_DIR, { recursive: true });

  // Get video info to find thumbnail
  const args = [...baseArgs(), url];
  const { stdout } = await run(YTDLP_PATH, args, 60);
  const lines = stdout.split('\n').filter(l => l.trim());
  const videoInfo = JSON.parse(lines[0]);

  // Pick best thumbnail under maxWidth
  let thumb = null;
  const thumbs = (videoInfo.thumbnails || []).sort((a, b) => (b.width || 0) - (a.width || 0));
  for (const t of thumbs) {
    if ((t.width || 0) <= maxWidth) { thumb = t.url; break; }
  }
  if (!thumb && thumbs.length > 0) thumb = thumbs[thumbs.length - 1].url;
  if (!thumb) throw new Error('No thumbnails found');

  // Generate media_id
  const hash = createHash('sha256').update(`thumb:${url}:${maxWidth}`).digest('hex').slice(0, 12);
  const ext = extname(thumb.split('?')[0]).toLowerCase() || '.jpg';
  const filename = `thumb_${hash}${ext}`;
  const cachePath = join(CACHE_DIR, filename);

  // Check cache
  try {
    const s = await stat(cachePath);
    const buf = await readFile(cachePath);
    return {
      media_id: hash,
      filename,
      path: cachePath,
      size: s.size,
      width: videoInfo.thumbnails?.find(t => t.url === thumb)?.width || 0,
      height: videoInfo.thumbnails?.find(t => t.url === thumb)?.height || 0,
      cached: true,
      html_hint: `Pass media_id "${hash}" in render_video media array. Reference as src="assets/${filename}"`,
    };
  } catch {}

  // Download
  await run('curl', ['-sL', '-o', cachePath, '--max-time', '30', thumb]);
  const s = await stat(cachePath);
  if (s.size < 100) {
    await unlink(cachePath).catch(() => {});
    throw new Error(`Thumbnail download failed (empty file) from ${thumb}`);
  }

  // Save meta
  const meta = {
    media_id: hash,
    filename,
    path: cachePath,
    url: thumb,
    size: s.size,
    width: videoInfo.thumbnails?.find(t => t.url === thumb)?.width || 0,
    height: videoInfo.thumbnails?.find(t => t.url === thumb)?.height || 0,
    cached: true,
  };
  const { saveMeta } = await import('./media.js');
  await saveMeta(hash, meta);

  return {
    ...meta,
    html_hint: `Pass media_id "${hash}" in render_video media array. Reference as src="assets/${filename}"`,
  };
}

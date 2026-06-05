// Media download, cache, and trim manager
// Stateless — all state on disk in MEDIA_CACHE_DIR
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat, unlink, mkdir, symlink, lstat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const CACHE_DIR = process.env.MEDIA_CACHE_DIR || join(homedir(), '.cache', 'mcp-video-renderer', 'media');
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || '';
const YTDLP_FORMAT = process.env.YTDLP_FORMAT || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

// Ensure cache dir exists
async function ensureCache() {
  await mkdir(CACHE_DIR, { recursive: true });
}

// Generate a stable media_id from URL + trim params
function mediaIdFor(url, start, end) {
  const h = createHash('sha256')
    .update(`${url}|${start || ''}|${end || ''}`)
    .digest('hex')
    .slice(0, 12);
  return h;
}

// Get path to media file in cache
function cachePath(mediaId, ext) {
  return join(CACHE_DIR, `${mediaId}${ext}`);
}

// Get path to metadata file
function metaPath(mediaId) {
  return join(CACHE_DIR, `${mediaId}.meta.json`);
}

// Run a command and return stdout
function run(cmd, args, timeout = 300) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout * 1000,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}

// Get media info via ffprobe
async function probeInfo(filePath) {
  const json = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams',
    filePath,
  ]);
  const data = JSON.parse(json);
  const video = data.streams?.find(s => s.codec_type === 'video');
  const audio = data.streams?.find(s => s.codec_type === 'audio');
  return {
    duration: parseFloat(data.format?.duration || 0),
    width: video?.width || 0,
    height: video?.height || 0,
    codec: video?.codec_name || '',
    fps: video?.r_frame_rate ? eval(video.r_frame_rate) : 30,
    hasAudio: !!audio,
    size: parseInt(data.format?.size || 0),
  };
}

// Save metadata to cache
export async function saveMeta(mediaId, meta) {
  await writeFile(metaPath(mediaId), JSON.stringify(meta, null, 2));
}

// Load metadata from cache
export async function loadMeta(mediaId) {
  try {
    const raw = await readFile(metaPath(mediaId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Check if media is cached
async function getCached(mediaId) {
  const meta = await loadMeta(mediaId);
  if (!meta) return null;
  // Check if file exists
  try {
    await stat(meta.path);
    return meta;
  } catch {
    return null;
  }
}

/**
 * Download media from URL via yt-dlp, optionally trim with ffmpeg.
 * Returns { media_id, filename, duration, width, height, size, url }
 */
export async function downloadMedia({ url, start, end }) {
  await ensureCache();
  const mediaId = mediaIdFor(url, start, end);
  const cached = await getCached(mediaId);
  if (cached) {
    console.log(`[media] Cache hit: ${mediaId} (${cached.filename})`);
    return cached;
  }

  console.log(`[media] Downloading: ${url} (start=${start || 'none'}, end=${end || 'none'})`);

  // Step 1: Download with yt-dlp (or just curl for direct URLs)
  const isDirectUrl = /^(https?:\/\/).+\.(mp4|webm|mov|mkv|avi|mp3|wav|m4a|ogg|flac|jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
  const isTwitter = /twitter\.com|x\.com|t\.co/i.test(url);

  let rawFile, rawExt;

  if (isDirectUrl && !isTwitter) {
    // Direct media URL — use curl
    const urlExt = extname(url.split('?')[0]).toLowerCase();
    rawExt = urlExt || '.mp4';
    rawFile = join(CACHE_DIR, `raw_${mediaId}${rawExt}`);
    await run('curl', ['-sL', '-o', rawFile, '--max-time', '300', url]);
  } else {
    // yt-dlp supported URL (YouTube, Twitter, etc.)
    const rawId = mediaIdFor(url, null, null);
    rawFile = join(CACHE_DIR, `raw_${rawId}.mp4`);
    rawExt = '.mp4';

    const ytdlpArgs = [
      '-f', YTDLP_FORMAT,
      '--merge-output-format', 'mp4',
      '-o', rawFile,
      '--max-filesize', '500M',
      '--no-playlist',
      '--concurrent-fragments', '4',
    ];

    // Cookies support
    if (YTDLP_COOKIES) {
      try {
        await stat(YTDLP_COOKIES);
        ytdlpArgs.push('--cookies', YTDLP_COOKIES);
      } catch {
        console.log(`[media] Warning: YTDLP_COOKIES=${YTDLP_COOKIES} not found, skipping`);
      }
    }

    // Extract from Twitter/X using browser if needed
    if (isTwitter) {
      ytdlpArgs.push('--extractor-args', 'twitter:api=syndication');
    }

    ytdlpArgs.push(url);
    await run('yt-dlp', ytdlpArgs, 600);
  }

  // Verify download
  const rawStat = await stat(rawFile);
  if (rawStat.size < 100) {
    throw new Error(`Download produced empty/tiny file (${rawStat.size} bytes) from ${url}`);
  }

  // Step 2: Trim if start/end specified
  let outFile = rawFile;
  let outExt = rawExt || '.mp4';
  const needTrim = (start != null && start > 0) || end != null;

  if (needTrim) {
    outExt = '.mp4';
    outFile = cachePath(mediaId, outExt);
    const trimArgs = ['-y', '-i', rawFile];

    if (start != null && start > 0) {
      trimArgs.push('-ss', String(start));
    }
    if (end != null) {
      trimArgs.push('-to', String(end));
    }

    trimArgs.push('-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', outFile);
    await run('ffmpeg', trimArgs, 300);

    // Clean up raw file if trimmed result is different
    if (outFile !== rawFile) {
      await unlink(rawFile).catch(() => {});
    }
  } else {
    // Rename raw to final name
    const finalPath = cachePath(mediaId, rawExt || '.mp4');
    if (rawFile !== finalPath) {
      const { rename } = await import('node:fs/promises');
      await rename(rawFile, finalPath);
      outFile = finalPath;
    }
  }

  // Step 3: Probe info and cache metadata
  const info = await probeInfo(outFile);
  const filename = basename(outFile);
  const meta = {
    media_id: mediaId,
    filename,
    path: outFile,
    url,
    start: start ?? null,
    end: end ?? null,
    duration: info.duration,
    width: info.width,
    height: info.height,
    codec: info.codec,
    fps: info.fps,
    hasAudio: info.hasAudio,
    size: await (await stat(outFile)).size,
  };
  await saveMeta(mediaId, meta);

  console.log(`[media] Cached: ${mediaId} → ${filename} (${meta.duration.toFixed(1)}s, ${meta.width}x${meta.height})`);
  return meta;
}

/**
 * Symlink a cached media file into a target directory's assets folder.
 * Returns the relative path (e.g., "assets/video_abc123.mp4") for use in HTML.
 */
export async function linkMediaToWorkdir(mediaId, workdir) {
  const meta = await loadMeta(mediaId);
  if (!meta) throw new Error(`Media ${mediaId} not found in cache`);

  const assetsDir = join(workdir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  // Use a clean filename for the workdir
  const ext = extname(meta.filename) || '.mp4';
  const workName = `video_${mediaId}${ext}`;
  const workPath = join(assetsDir, workName);

  try {
    // Try symlink first (fast, no copy)
    await symlink(meta.path, workPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Already linked, fine
    } else if (err.code === 'EPERM' || err.code === 'EXDEV') {
      // Cross-device or no symlink support — copy instead
      const { copyFile } = await import('node:fs/promises');
      await copyFile(meta.path, workPath);
    } else {
      throw err;
    }
  }

  return `assets/${workName}`;
}

/**
 * List all cached media items
 */
export async function listCachedMedia() {
  await ensureCache();
  const files = await readdir(CACHE_DIR);
  const items = [];

  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const raw = await readFile(join(CACHE_DIR, f), 'utf-8');
      const meta = JSON.parse(raw);
      items.push({
        media_id: meta.media_id,
        url: meta.url,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        size: meta.size,
        filename: meta.filename,
        start: meta.start,
        end: meta.end,
      });
    } catch {}
  }

  return items;
}

/**
 * Remove a cached media item
 */
export async function removeCachedMedia(mediaId) {
  const meta = await loadMeta(mediaId);
  if (!meta) throw new Error(`Media ${mediaId} not found in cache`);

  const { unlink } = await import('node:fs/promises');
  try { await unlink(meta.path); } catch {}
  try { await unlink(metaPath(mediaId)); } catch {}

  console.log(`[media] Removed: ${mediaId}`);
  return { removed: mediaId };
}

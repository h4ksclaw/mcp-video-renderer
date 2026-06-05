#!/usr/bin/env node
// MCP Video Renderer Server — StreamableHTTP transport
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createStorage } from './storage.js';
import { renderVideo } from './renderer.js';
import { downloadMedia, listCachedMedia, removeCachedMedia, saveMeta, loadMeta } from './media.js';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import express from 'express';

const PORT = parseInt(process.env.PORT || '3100', 10);
const storage = createStorage();

// Simple render queue — one job at a time to avoid CPU spikes
const queue = {
  current: null,
  waiting: [],
  enqueue(job) {
    this.waiting.push(job);
    this.drain();
  },
  drain() {
    if (this.current || this.waiting.length === 0) return;
    this.current = this.waiting.shift();
    this.current.run().finally(() => {
      this.current = null;
      this.drain();
    });
  },
};

// Helper: run a command and return { stdout, stderr }
function run(cmd, args, timeout = 120, allowNonZero = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeout * 1000,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 || allowNonZero) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      } else {
        reject(new Error(`${cmd} failed (exit ${code}): ${stderr.slice(-1000)}`));
      }
    });
    proc.on('error', reject);
  });
}

// Create MCP server
const getServer = () => {
  const server = new McpServer(
    { name: 'video-renderer', version: '0.2.0' },
    { capabilities: { logging: {} } }
  );

  // ─── Tool: render_video ────────────────────────────────────────────
  server.registerTool('render_video', {
    title: 'Render Video',
    description: `Render an HTML+GSAP composition to MP4 video via Hyperframes.

⚠️ IMPORTANT: Before authoring HTML, load the skill 'hyperframes-video-generation' for design systems, composition rules, typography, transitions, and craft. Also read official docs at https://hyperframes.mintlify.app/llms.txt for the full reference index.

QUICK RULES (broken compositions = bad video):
- HTML must be base64-encoded.
- Must include <div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">.
- GSAP: always use gsap.timeline({ paused: true }), register on window.__timelines["main"].
- class="clip" + data-start + data-duration + data-track-index on ALL timed elements.
- No Math.random() — use seeded PRNG. No async/await during timeline setup. No fetch().
- Animate wrapper divs around <video>, never <video> directly. Never call .play()/.pause().
- All elements: position:absolute with top/left (never bottom — causes clipping).
- Canvas: 1920×1080 for landscape (1080p), 1080×1920 for portrait.
- Audio: pass as base64 WAV/MP3 in 'audio' param — injected as <audio data-start="0" data-duration="N" data-volume="0.8" src="assets/audio.wav">.
- data-width/data-height on #root determines orientation. Must match --resolution.
- Timeline duration = composition duration. Extend with tl.set({}, {}, DURATION) if needed.

MEDIA REFERENCES: Use the 'media' param to include pre-downloaded videos/images in your composition. First call download_media to get a media_id, then pass it here. The HTML references these as local files in assets/ (e.g., src="assets/video_abc123.mp4"). The download_media tool returns the exact filename to use.

Returns a URL to the rendered MP4 file.`,
    annotations: {
      openWorldHint: true,
    },
    inputSchema: {
      html: z.string().describe('Full HTML composition with inline CSS and GSAP animations. Must use position:absolute, top/left (never bottom). Canvas is 1920x1080.'),
      audio: z.string().optional().describe('Base64-encoded audio data (WAV/MP3). Injected as <audio> element.'),
      audio_volume: z.number().min(0).max(1).default(0.9).describe('Audio volume 0-1.'),
      fps: z.number().int().min(1).max(60).default(30).describe('Frames per second.'),
      resolution: z.enum(['1080p', '4k', 'uhd', 'landscape', 'portrait', 'square']).default('1080p').describe('Output resolution.'),
      duration: z.number().optional().describe('Expected duration in seconds. Used for progress if Hyperframes doesn\'t report frame counts.'),
      media: z.array(z.object({
        media_id: z.string().describe('Media ID from download_media tool.'),
      })).optional().describe('Array of media references to include in the composition. Files are symlinked into assets/ for HTML to reference.'),
    },
  }, async ({ html, audio, audio_volume, fps, resolution, duration, media }, extra) => {
    const jobId = randomUUID().slice(0, 8);

    // Calculate expected frames for progress
    const totalFrames = duration
      ? Math.ceil((duration || 30) * (fps || 30))
      : null;

    let lastReported = 0;
    const reportProgress = (p) => {
      const progress = totalFrames ? Math.round((p.current / p.total) * 100) : p.current;
      if (progress !== lastReported && extra._meta?.progressToken) {
        lastReported = progress;
        extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: extra._meta.progressToken,
            progress: p.current,
            total: p.total || totalFrames,
            message: `Rendering frame ${p.current}/${p.total || totalFrames || '?'}`,
          },
        }).catch(() => {});
      }
    };

    try {
      // Run render (may queue if another job is running)
      const result = await new Promise((resolve, reject) => {
        queue.enqueue({
          run: async () => {
            try {
              const res = await renderVideo(
                { html, audio, audioVolume: audio_volume, fps, resolution, media },
                reportProgress
              );
              resolve(res);
            } catch (err) {
              reject(err);
            }
          },
        });
      });

      // Store the video
      const url = await storage.save(result.buffer, result.filename);

      return {
        content: [
          { type: 'text', text: `Render complete: ${url} (${result.size} bytes)` },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Render failed: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Tool: download_media ───────────────────────────────────────────
  server.registerTool('download_media', {
    title: 'Download Media',
    description: `Download a video or image from any yt-dlp compatible URL (YouTube, Twitter/X, TikTok, Instagram, Reddit, Vimeo, direct MP4 links, etc.) into the server's media cache. Optionally trim with start/end times. Returns a media_id for use in render_video.

The media is downloaded once and cached on disk. Subsequent calls with the same URL+trim params return the cached result instantly. No base64 blobs — just pass the media_id to render_video.

Supported sources: YouTube, Twitter/X, TikTok, Instagram, Reddit, Vimeo, Dailymotion, Twitch, SoundCloud, and any direct media URL (.mp4, .webm, .mov, .mp3, .wav, .jpg, .png, .webp, etc.)

Cookie/auth: Set YTDLP_COOKIES env var to a Netscape cookies.txt file for authenticated downloads.`,
    annotations: {
      openWorldHint: true,
    },
    inputSchema: {
      url: z.string().describe('URL to download from. Any yt-dlp compatible source or direct media URL.'),
      start: z.number().optional().describe('Start time in seconds (trim from beginning).'),
      end: z.number().optional().describe('End time in seconds (trim from end).'),
    },
  }, async ({ url, start, end }) => {
    try {
      const result = await downloadMedia({ url, start, end });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            media_id: result.media_id,
            filename: result.filename,
            url: result.url,
            duration: result.duration,
            width: result.width,
            height: result.height,
            hasAudio: result.hasAudio,
            size: result.size,
            start: result.start,
            end: result.end,
            html_hint: `Reference in HTML as: src="assets/${result.filename}" (pass media_id "${result.media_id}" in render_video media array)`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Download failed: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Tool: media_cache ──────────────────────────────────────────────
  server.registerTool('media_cache', {
    title: 'Media Cache',
    description: 'List or manage the server media cache. Shows all cached downloads with their IDs, URLs, durations, and sizes. Use this to find media_ids for render_video.',
    inputSchema: {
      action: z.enum(['list', 'remove']).default('list').describe('List all cached media, or remove one by media_id.'),
      media_id: z.string().optional().describe('Media ID to remove (required when action=remove).'),
    },
  }, async ({ action, media_id }) => {
    try {
      if (action === 'remove') {
        if (!media_id) return { content: [{ type: 'text', text: 'media_id required for remove action' }], isError: true };
        const result = await removeCachedMedia(media_id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      const items = await listCachedMedia();
      if (items.length === 0) {
        return { content: [{ type: 'text', text: 'Media cache is empty. Use download_media to download videos/images.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Cache error: ${err.message}` }], isError: true };
    }
  });

  // ─── Tool: tts ─────────────────────────────────────────────────────
  server.registerTool('tts', {
    title: 'Text to Speech',
    description: `Generate speech audio from text using Kokoro-82M (built into Hyperframes). Returns base64 WAV audio data to pass as the 'audio' param in render_video.

Available voices:
- af_heart (Heart) — American female, warm
- af_nova (Nova) — American female, bright
- af_sky (Sky) — American female, calm
- am_adam (Adam) — American male, deep
- am_michael (Michael) — American male, neutral
- bf_emma (Emma) — British female
- bf_isabella (Isabella) — British female
- bm_george (George) — British male
- ef_dora (Dora) — European French female
- ff_siwis (Siwis) — French female
- jf_alpha (Alpha) — Japanese female
- zf_xiaobei (Xiaobei) — Chinese female`,
    inputSchema: {
      text: z.string().describe('Text to speak.'),
      voice: z.string().default('am_adam').describe('Voice ID (default: am_adam). See description for options.'),
      speed: z.number().min(0.5).max(2.0).default(1.0).describe('Speech speed multiplier (0.5-2.0).'),
    },
  }, async ({ text, voice, speed }) => {
    try {
      const tmpId = randomUUID().slice(0, 8);
      const outPath = `/tmp/tts-${tmpId}.wav`;

      const args = ['hyperframes', 'tts', '-o', outPath, '-v', voice, '-s', String(speed), text];
      console.log(`[tts] Running: ${args.join(' ')}`);
      await run('npx', args, 60);

      const { readFile } = await import('node:fs/promises');
      const { unlink } = await import('node:fs/promises');
      const buf = await readFile(outPath);
      await unlink(outPath).catch(() => {});

      const b64 = buf.toString('base64');
      console.log(`[tts] Generated ${(buf.length / 1024).toFixed(1)} KB of audio`);

      return {
        content: [{
          type: 'text',
          text: `TTS complete: ${(buf.length / 1024).toFixed(1)} KB WAV. Pass the base64 string below as the 'audio' param in render_video.\n\nBase64:\n${b64}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `TTS failed: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Tool: remove_background ────────────────────────────────────────
  server.registerTool('remove_background', {
    title: 'Remove Background',
    description: `Remove background from a video or image using AI (built into Hyperframes). For videos, outputs transparent WebM. For images, outputs transparent PNG.

INPUT: Either a direct URL to a video/image, or a media_id from download_media (if you already downloaded it).

OUTPUT: Returns a new media_id for the transparent version. Pass this media_id in render_video's media array.`,
    inputSchema: {
      input: z.string().describe('Either a media_id from download_media (e.g., "abc123def456"), or a direct URL to a video/image file.'),
      format: z.enum(['webm', 'mov', 'png']).default('webm').describe('Output format: webm (video, default), mov (video, ProRes 4444), png (image only).'),
    },
  }, async ({ input, format }) => {
    try {
      let inputFile;
      const isMediaId = !input.startsWith('http');

      if (isMediaId) {
        const meta = await loadMeta(input);
        if (!meta) return { content: [{ type: 'text', text: `Media ${input} not found in cache` }], isError: true };
        inputFile = meta.path;
      } else {
        const tmpId = randomUUID().slice(0, 8);
        inputFile = `/tmp/rmbg-${tmpId}.mp4`;
        await run('curl', ['-sL', '-o', inputFile, '--max-time', '120', input]);
      }

      const isImage = /\.(jpg|jpeg|png|webp)$/i.test(inputFile);
      const outFormat = isImage ? 'png' : format;
      const tmpId = randomUUID().slice(0, 8);
      const outputPath = `/tmp/rmbg-out-${tmpId}.${outFormat}`;

      console.log(`[rmbg] Removing background from ${inputFile} → ${outputPath}`);
      const args = ['hyperframes', 'remove-background', '-o', outputPath, inputFile];
      await run('npx', args, 300);

      // Read output
      const buf = await readFile(outputPath);
      const fileSize = buf.length;

      // Probe info
      let info = {};
      try {
        const json = await run('ffprobe', [
          '-v', 'quiet', '-print_format', 'json',
          '-show_format', '-show_streams', outputPath,
        ]);
        const data = JSON.parse(json);
        const video = data.streams?.find(s => s.codec_type === 'video');
        info = {
          duration: parseFloat(data.format?.duration || 0),
          width: video?.width || 0,
          height: video?.height || 0,
        };
      } catch {}

      // Store in media cache
      const cacheId = createHash('sha256').update(`rmbg:${input}:${outFormat}`).digest('hex').slice(0, 12);
      const cacheDir = process.env.MEDIA_CACHE_DIR || join(homedir(), '.cache', 'mcp-video-renderer', 'media');
      await mkdir(cacheDir, { recursive: true });
      const cacheFile = join(cacheDir, `rmbg_${cacheId}.${outFormat}`);
      await writeFile(cacheFile, buf);

      const meta = {
        media_id: cacheId,
        filename: `rmbg_${cacheId}.${outFormat}`,
        path: cacheFile,
        url: `rmbg://${input}`,
        start: null,
        end: null,
        duration: info.duration || 0,
        width: info.width || 0,
        height: info.height || 0,
        codec: outFormat === 'png' ? 'png' : (outFormat === 'mov' ? 'prores' : 'vp9'),
        hasAudio: false,
        size: fileSize,
      };
      await saveMeta(cacheId, meta);

      // Cleanup temp files
      if (!isMediaId) await unlink(inputFile).catch(() => {});
      await unlink(outputPath).catch(() => {});

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            media_id: cacheId,
            filename: meta.filename,
            format: outFormat,
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            size: fileSize,
            html_hint: `Pass media_id "${cacheId}" in render_video media array. Reference in HTML as: src="assets/${meta.filename}"`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Remove background failed: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Tool: lint ─────────────────────────────────────────────────────
  server.registerTool('lint', {
    title: 'Lint Composition',
    description: `Validate an HTML+GSAP composition for common mistakes before rendering. Catches missing attributes, wrong GSAP usage, positioning issues, timing problems, and more. Always run this before render_video to catch errors early.

Accepts base64-encoded HTML (same format as render_video). Returns lint output as text.`,
    inputSchema: {
      html: z.string().describe('Base64-encoded HTML composition to lint (same format as render_video).'),
    },
  }, async ({ html }) => {
    try {
      const tmpId = randomUUID().slice(0, 8);
      const workDir = `/tmp/lint-${tmpId}`;
      await mkdir(workDir, { recursive: true });

      const htmlContent = Buffer.from(html, 'base64').toString('utf-8');
      await writeFile(`${workDir}/index.html`, htmlContent);

      const args = ['hyperframes', 'lint', workDir];
      console.log(`[lint] Running: ${args.join(' ')}`);

      const result = await run('npx', args, 30, true);
      const output = result.stdout || result.stderr;

      await rm(workDir, { recursive: true, force: true }).catch(() => {});

      return {
        content: [{
          type: 'text',
          text: output || 'Lint passed — no issues found.',
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Lint failed: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Tool: render_queue ─────────────────────────────────────────────
  server.registerTool('render_queue', {
    title: 'Render Queue Status',
    description: 'Check current render queue status — how many jobs waiting, current job.',
    inputSchema: {},
  }, async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          currentJob: queue.current ? 'running' : 'idle',
          queued: queue.waiting.length,
        }),
      }],
    };
  });

  return server;
};

// Express + StreamableHTTP setup
const app = express();
const transports = {};

// JSON body parsing with 50MB limit for base64 audio
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// Static file serving for local storage mode
if (storage.type === 'local') {
  const servePath = process.env.STORAGE_PATH || './output';
  app.use('/output', express.static(servePath));
  console.log(`[mcp] Serving local files at /output from ${servePath}`);
}

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  try {
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          console.log(`[mcp] Session initialized: ${id}`);
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      const server = getServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] Error:', err.message || err);
    console.error('[mcp] Stack:', err.stack);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Missing or invalid session ID');
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Missing or invalid session ID');
  }
  await transports[sessionId].handleRequest(req, res);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.2.0',
    storage: storage.type,
    cacheDir: process.env.MEDIA_CACHE_DIR || `${homedir()}/.cache/mcp-video-renderer/media`,
    ytDlpCookies: process.env.YTDLP_COOKIES || 'not set',
    queue: {
      current: queue.current ? 'running' : 'idle',
      queued: queue.waiting.length,
    },
  });
});

// Start
app.listen(PORT, () => {
  console.log(`[mcp] Video renderer MCP server v0.2.0 on port ${PORT}`);
  console.log(`[mcp] Transport: StreamableHTTP at /mcp`);
  console.log(`[mcp] Storage: ${storage.type}`);
  console.log(`[mcp] Media cache: ${process.env.MEDIA_CACHE_DIR || '~/.cache/mcp-video-renderer/media'}`);
  console.log(`[mcp] yt-dlp cookies: ${process.env.YTDLP_COOKIES || 'not configured'}`);
});

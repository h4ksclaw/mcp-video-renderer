// Hyperframes render wrapper — shells out to hyperframes CLI
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { linkMediaToWorkdir } from './media.js';

// Regex to extract frame progress from Hyperframes stderr
const FRAME_REGEX = /Streaming frame\s*(\d+)\s*\/\s*(\d+)/;

export async function renderVideo({ html, audio, audioVolume, fps, resolution, media }, onProgress) {
  const jobId = randomUUID().slice(0, 8);
  const workDir = join(process.env.WORKDIR || '/tmp/mcp-render-jobs', jobId);
  const assetsDir = join(workDir, 'assets');
  const outputFile = join(workDir, 'output.mp4');

  await mkdir(workDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  try {
    // Decode HTML from base64
    let htmlContent = Buffer.from(html, 'base64').toString('utf-8');

    // Link media from cache into workdir assets
    const mediaPaths = {};
    if (media && media.length > 0) {
      for (const m of media) {
        const relPath = await linkMediaToWorkdir(m.media_id, workDir);
        mediaPaths[m.media_id] = relPath;
        console.log(`[renderer] Linked media ${m.media_id} → ${relPath}`);
      }
    }

    // Inject audio if provided — write file and add <audio> element
    if (audio) {
      const audioBytes = Buffer.from(audio, 'base64');
      const audioPath = join(assetsDir, 'audio.wav');
      await writeFile(audioPath, audioBytes);

      // Detect composition duration from #root data-duration
      const durationMatch = htmlContent.match(/data-duration\s*=\s*["'](\d+(?:\.\d+)?)["']/);
      const duration = durationMatch ? durationMatch[1] : '30';
      const volume = audioVolume || 0.9;

      // Inject <audio> element before </body> if not already present
      if (!htmlContent.includes('<audio')) {
        const audioTag = `\n<audio data-start="0" data-duration="${duration}" data-volume="${volume}" src="assets/audio.wav"></audio>\n`;
        htmlContent = htmlContent.replace('</body>', `${audioTag}</body>`);
      }
    }

    // Write HTML composition
    await writeFile(join(workDir, 'index.html'), htmlContent);

    // Build command — no --audio flag, hyperframes handles <audio> elements
    const args = [
      'hyperframes', 'render', workDir,
      '--output', outputFile,
      '--fps', String(fps || 30),
      '--resolution', resolution || '1080p',
    ];

    console.log(`[renderer] Starting render job ${jobId}: npx ${args.join(' ')}`);

    // Spawn the render process
    const proc = spawn('npx', args, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;

      // Parse frame progress
      const match = text.match(FRAME_REGEX);
      if (match) {
        onProgress?.({
          current: parseInt(match[1], 10),
          total: parseInt(match[2], 10),
        });
      }
    });

    // Wait for completion
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
    });

    if (exitCode !== 0) {
      const error = stderr.slice(-2000);
      throw new Error(`Render failed (exit ${exitCode}): ${error}`);
    }

    // Read output file
    const videoBuffer = await readFile(outputFile);
    const sizeKB = (videoBuffer.length / 1024).toFixed(1);
    console.log(`[renderer] Job ${jobId} done: ${sizeKB} KB`);

    return {
      buffer: videoBuffer,
      filename: `render-${jobId}.mp4`,
      size: videoBuffer.length,
    };
  } finally {
    // Cleanup work dir
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * ffprobe-based video metadata extraction.
 *
 * VNNOX/NovaStar VIDEO widgets in /v2/player/program/normal require the video's
 * codec, fps, pixel dimensions, byte rate and file extension — without them the
 * Taurus player accepts the program but shows a frozen first frame instead of
 * playing (images don't need these fields, which is why images always worked
 * and video never did). See vnnoxClient.buildMediaWidget.
 *
 * sharp can't read video, so we shell out to ffprobe (installed in the runtime
 * image via `apk add ffmpeg`). Everything here is best-effort: any failure
 * returns null and the caller falls back to the old image-only widget shape.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

export interface VideoMeta {
  widthPx: number;
  heightPx: number;
  fps: number;
  codec: string;          // e.g. 'h264'
  byteRateKbps: number;   // container bit rate in kbps (VNNOX "byteRate")
  durationMs: number;
  postfix: string;        // file extension without dot, e.g. 'mp4'
}

// Cache by md5 so repeated deploys of the same playlist don't re-download +
// re-probe the same asset. Cleared on process restart, which is fine.
const cache = new Map<string, VideoMeta>();

/**
 * Download a public media URL to a temp file and ffprobe it. Returns null on
 * any failure (network, unsupported, ffprobe missing) — callers must treat a
 * null as "no metadata available" and skip the video-specific widget fields.
 */
export async function probeVideoFromUrl(
  url: string,
  cacheKey?: string,
  timeoutMs = 20000,
): Promise<VideoMeta | null> {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;

  let tmpPath: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(new URL(url).pathname) || '.mp4';
    tmpPath = path.join(os.tmpdir(), `probe-${crypto.randomUUID()}${ext}`);
    await fs.promises.writeFile(tmpPath, buf);

    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,codec_name',
        '-show_entries', 'format=duration,bit_rate',
        '-of', 'json',
        tmpPath,
      ],
      { timeout: timeoutMs },
    );

    const data = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; codec_name?: string }>;
      format?: { duration?: string; bit_rate?: string };
    };
    const s = data.streams?.[0];
    if (!s?.width || !s?.height) return null;

    const [num, den] = String(s.avg_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? Math.round(num / den) : 0;
    const bitRate = Number(data.format?.bit_rate || 0);

    const meta: VideoMeta = {
      widthPx: Number(s.width),
      heightPx: Number(s.height),
      fps: fps || 30,
      codec: String(s.codec_name || 'h264'),
      byteRateKbps: bitRate ? Math.round(bitRate / 1000) : 0,
      durationMs: data.format?.duration ? Math.round(Number(data.format.duration) * 1000) : 0,
      postfix: ext.replace(/^\./, '').toLowerCase() || 'mp4',
    };
    if (cacheKey) cache.set(cacheKey, meta);
    return meta;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[videoProbe] failed for ${url}: ${(err as Error).message}`);
    return null;
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => undefined);
  }
}

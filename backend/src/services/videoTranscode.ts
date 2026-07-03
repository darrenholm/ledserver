/**
 * Auto-normalize uploaded videos to something a NovaStar Taurus player can
 * actually decode. Apple/phone exports are routinely H.264 High@5.0, >1920 wide,
 * 60fps or variable-frame-rate — all of which the Taurus shows as a frozen
 * frame. Rather than make clients understand codecs, we transcode on upload.
 *
 * Only re-encodes files that fall outside the safe envelope; already-clean files
 * are left untouched. Best-effort: any ffprobe/ffmpeg failure keeps the original
 * so the upload never breaks (worst case is the old behaviour, not a hard error).
 *
 * ffmpeg/ffprobe come from `apk add ffmpeg` in the runtime image.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

/** The subset of an uploaded file we read + rewrite. Matches Express.Multer.File. */
export interface NormalizableFile {
  path: string;
  filename: string;
  mimetype: string;
  size: number;
}

// Conservative Taurus decode envelope. Anything outside → re-encode.
const SAFE_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main']);
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MAX_FPS = 30;

interface ProbeStream {
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

function fpsOf(ratio: string | undefined): number {
  const [n, d] = String(ratio || '0/1').split('/').map(Number);
  return d ? n / d : 0;
}

async function probe(filePath: string): Promise<ProbeStream | null> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate',
      '-of', 'json',
      filePath,
    ],
    { timeout: 30000 },
  );
  return (JSON.parse(stdout) as { streams?: ProbeStream[] }).streams?.[0] ?? null;
}

function isTaurusSafe(s: ProbeStream | null): boolean {
  if (!s) return false;
  if (s.codec_name !== 'h264') return false;
  if (!SAFE_PROFILES.has(String(s.profile))) return false;
  if (Number(s.width) > MAX_WIDTH || Number(s.height) > MAX_HEIGHT) return false;
  if (String(s.pix_fmt) !== 'yuv420p') return false;
  const avg = fpsOf(s.avg_frame_rate);
  const r = fpsOf(s.r_frame_rate);
  if (avg > MAX_FPS + 0.5) return false;
  // r_frame_rate far from avg_frame_rate signals variable frame rate, which
  // hardware decoders stutter or stall on.
  if (Math.abs(r - avg) > 1) return false;
  return true;
}

/**
 * Ensure `file` is Taurus-decodable, transcoding in place if needed. Mutates
 * file.path / filename / mimetype / size to point at the normalized .mp4.
 * Returns true if a transcode happened, false if the file was already safe
 * (or if normalization failed and the original was kept).
 */
export async function ensureTaurusSafeVideo(file: NormalizableFile): Promise<boolean> {
  try {
    const stream = await probe(file.path);
    if (isTaurusSafe(stream)) return false;

    const dir = path.dirname(file.path);
    const base = path.basename(file.filename, path.extname(file.filename));
    const finalPath = path.join(dir, `${base}.mp4`);
    const tmpPath = path.join(dir, `${base}-taurus-${crypto.randomBytes(4).toString('hex')}.mp4`);

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', file.path,
        '-c:v', 'libx264', '-profile:v', 'main', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
        '-vf', `scale='min(${MAX_WIDTH},iw)':-2:flags=lanczos,fps=${MAX_FPS}`,
        '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M', '-g', '30', '-bf', '0',
        '-movflags', '+faststart', '-an',
        tmpPath,
      ],
      { timeout: 180000 },
    );

    // Put the normalized file in place first (atomic if it replaces the same
    // name), then remove the source only if it had a different extension —
    // so there's never a moment with no usable file on disk.
    await fs.promises.rename(tmpPath, finalPath);
    if (path.resolve(file.path) !== path.resolve(finalPath)) {
      await fs.promises.rm(file.path, { force: true });
    }
    const stat = await fs.promises.stat(finalPath);

    file.path = finalPath;
    file.filename = `${base}.mp4`;
    file.mimetype = 'video/mp4';
    file.size = stat.size;
    // eslint-disable-next-line no-console
    console.log(`[videoTranscode] normalized ${base} to Taurus-safe mp4 (${stat.size} bytes)`);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[videoTranscode] normalize failed for ${file.filename}: ${(err as Error).message}`);
    return false;
  }
}

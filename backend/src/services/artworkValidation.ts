import sharp from 'sharp';

export interface ArtworkProbeResult {
  widthPx: number | null;
  heightPx: number | null;
  warnings: string[];
}

interface ProbeOptions {
  targetWidth?: number | null;
  targetHeight?: number | null;
  /** Allowable aspect ratio error in percent (0-100). Default 2 (±2%). */
  aspectRatioTolerance?: number;
  /** Allowable resolution shortfall in percent (0-100). Default 25 (we'll warn if narrower than 75% of target). */
  resolutionTolerance?: number;
  mimeType?: string;
}

/**
 * Inspect an uploaded image file and return its pixel dimensions plus a list
 * of human-readable warnings about how it'll display on a target screen.
 *
 * Video files are not probed by sharp; for those, callers should run ffprobe
 * separately. For now we just return null dimensions and a single warning.
 */
export async function probeArtwork(filePath: string, opts: ProbeOptions = {}): Promise<ArtworkProbeResult> {
  const warnings: string[] = [];

  if (opts.mimeType?.startsWith('video/')) {
    warnings.push('video file — dimension validation skipped (will be checked manually during review)');
    return { widthPx: null, heightPx: null, warnings };
  }
  if (opts.mimeType && !opts.mimeType.startsWith('image/')) {
    warnings.push(`file type "${opts.mimeType}" is not an image — manual review required`);
    return { widthPx: null, heightPx: null, warnings };
  }

  let widthPx: number | null = null;
  let heightPx: number | null = null;

  try {
    const meta = await sharp(filePath).metadata();
    widthPx = meta.width ?? null;
    heightPx = meta.height ?? null;
  } catch (err) {
    warnings.push(`could not read image dimensions: ${(err as Error).message}`);
    return { widthPx, heightPx, warnings };
  }

  if (!widthPx || !heightPx) {
    warnings.push('image has no readable dimensions');
    return { widthPx, heightPx, warnings };
  }

  if (opts.targetWidth && opts.targetHeight) {
    const targetAR = opts.targetWidth / opts.targetHeight;
    const sourceAR = widthPx / heightPx;
    const arDiffPct = Math.abs(sourceAR - targetAR) / targetAR * 100;
    const arTolerance = opts.aspectRatioTolerance ?? 2;
    if (arDiffPct > arTolerance) {
      warnings.push(
        `aspect ratio ${sourceAR.toFixed(3)}:1 does not match display ${targetAR.toFixed(3)}:1 ` +
          `(off by ${arDiffPct.toFixed(1)}%). Image will be letterboxed or stretched.`,
      );
    }

    const resTolerance = opts.resolutionTolerance ?? 25;
    const minWidth = opts.targetWidth * (1 - resTolerance / 100);
    const minHeight = opts.targetHeight * (1 - resTolerance / 100);
    if (widthPx < minWidth || heightPx < minHeight) {
      warnings.push(
        `image resolution ${widthPx}×${heightPx} is below the display's ${opts.targetWidth}×${opts.targetHeight} — ` +
          `will be upscaled and may look blurry.`,
      );
    }
  }

  return { widthPx, heightPx, warnings };
}

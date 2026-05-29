/**
 * Server-side text-to-PNG renderer for slides composed in the admin UI or
 * the customer-facing rental booking form. One central implementation so
 * both surfaces produce identical-looking output.
 *
 * Render path: build an SVG with the headline centred and auto-sized to
 * fill ~85% of the panel width, then rasterise via sharp. The viewer can
 * always upload a real PNG if they want pixel-perfect typography.
 */
import { z } from 'zod';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Schema shared by all text-slide endpoints. Narrow font enum so we can
 * guarantee the font name resolves to something rasterisable on the
 * Railway box (no custom font loading in the standard sharp/librsvg
 * pipeline).
 */
export const textSlideSchema = z.object({
  text: z.string().min(1).max(120),
  textColor: z.string().regex(HEX_COLOR, 'expect #RRGGBB'),
  bgColor:   z.string().regex(HEX_COLOR, 'expect #RRGGBB'),
  fontFamily: z.enum(['sans', 'sans-bold', 'serif']).default('sans-bold'),
});

export type TextSlideInput = z.infer<typeof textSlideSchema>;

/**
 * Escape characters that have special meaning inside SVG text content.
 * Without this, an apostrophe in the headline can blow up the parser.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Returns the SVG markup for a text slide sized to the given panel.
 * Caller is responsible for rasterising to PNG via sharp.
 *
 * Sizing heuristic: pick a font size so the headline spans ~85% of the
 * panel width assuming an average glyph aspect of 0.55 (works well for
 * Helvetica/Arial). Clamp between height/8 and height*0.65 so a one-
 * character headline doesn't blow up to absurd proportions on a square
 * panel.
 */
export function buildTextSlideSvg(args: TextSlideInput & {
  widthPx: number;
  heightPx: number;
}): string {
  const fontMap: Record<string, string> = {
    'sans':      "Helvetica, Arial, 'DejaVu Sans', sans-serif",
    'sans-bold': "Helvetica, Arial, 'DejaVu Sans', sans-serif",
    'serif':     "Georgia, 'DejaVu Serif', serif",
  };
  const fontFamily = fontMap[args.fontFamily] || fontMap['sans-bold'];
  const fontWeight = args.fontFamily === 'sans-bold' ? '700' : '400';

  const targetWidthPx = args.widthPx * 0.85;
  const fitByWidth = targetWidthPx / Math.max(1, args.text.length * 0.55);
  const fitByHeight = args.heightPx * 0.65;
  const fontSize = Math.max(
    Math.floor(args.heightPx / 8),
    Math.min(fitByHeight, fitByWidth),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${args.widthPx}" height="${args.heightPx}"
     viewBox="0 0 ${args.widthPx} ${args.heightPx}">
  <rect width="100%" height="100%" fill="${args.bgColor}"/>
  <text x="50%" y="50%"
        font-family="${fontFamily}" font-weight="${fontWeight}"
        font-size="${Math.round(fontSize)}"
        fill="${args.textColor}"
        text-anchor="middle" dominant-baseline="middle">${escapeXml(args.text)}</text>
</svg>`;
}

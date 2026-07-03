/**
 * Side-by-side dual-panel screens (double-sided signs whose controller sees one
 * wide canvas split into two equal halves). Given a full-screen VNNOX media
 * widget, return two copies laid out on the left and right halves so a per-face
 * image fills each face at native size instead of stretching across the whole
 * width. Used by the publish paths when devices.dual_panel is set.
 */
export function panelWidgets(widget: Record<string, unknown>): Record<string, unknown>[] {
  const name = String(widget.name ?? 'w');
  return [
    { ...widget, name: `${name}-L`, layout: { x: '0%', y: '0%', width: '50%', height: '100%' } },
    { ...widget, name: `${name}-R`, layout: { x: '50%', y: '0%', width: '50%', height: '100%' } },
  ];
}

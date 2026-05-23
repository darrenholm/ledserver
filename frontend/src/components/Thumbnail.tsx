import { CSSProperties } from 'react';

/**
 * Minimum shape needed to render a preview. Both Media rows and the embedded
 * playlist-item summaries returned by GET /playlists conform to this.
 */
export interface ThumbnailLike {
  mime_type: string;
  storage_url: string;
  thumbnail_url?: string | null;
}

interface ThumbnailProps {
  m: ThumbnailLike;
  size?: number;
  /** width:height ratio of the box. Default 4:3 */
  ratio?: [number, number];
  style?: CSSProperties;
}

export function Thumbnail({ m, size = 80, ratio = [4, 3], style }: ThumbnailProps) {
  const height = Math.round((size * ratio[1]) / ratio[0]);
  const box: CSSProperties = {
    width: size,
    height,
    borderRadius: 4,
    background: 'var(--surface-2, #1f2937)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    fontSize: 11,
    color: 'var(--text-muted, #9ca3af)',
    flexShrink: 0,
    ...style,
  };
  const src = m.thumbnail_url ?? m.storage_url;
  if (m.mime_type.startsWith('image/')) {
    return (
      <div style={box}>
        <img
          src={src}
          alt=""
          loading="lazy"
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }
  if (m.mime_type.startsWith('video/')) {
    return (
      <div style={box}>
        <video
          src={m.storage_url}
          preload="metadata"
          muted
          playsInline
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }
  if (m.mime_type.startsWith('audio/')) {
    return <div style={box}>audio</div>;
  }
  return <div style={box}>file</div>;
}

interface ThumbnailStripProps {
  items: ThumbnailLike[];
  /** Total max to show before "+ N more". */
  max?: number;
  size?: number;
}

/**
 * Inline strip of thumbnails for playlist preview cells. Shows up to `max`
 * thumbnails and a "+N" pill when there are more.
 */
export function ThumbnailStrip({ items, max = 4, size = 56 }: ThumbnailStripProps) {
  if (items.length === 0) {
    return <span className="muted" style={{ fontSize: 12 }}>empty</span>;
  }
  const shown = items.slice(0, max);
  const overflow = items.length - shown.length;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {shown.map((m, i) => (
        <Thumbnail key={i} m={m} size={size} />
      ))}
      {overflow > 0 && (
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-muted, #9ca3af)',
            padding: '2px 6px',
            background: 'var(--surface-2, #1f2937)',
            borderRadius: 4,
          }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

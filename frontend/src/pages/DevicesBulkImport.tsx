import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { devices as devicesApi } from '../api/endpoints';

interface ParsedRow {
  raw: Record<string, string>;
  parsed: {
    name: string;
    latitude?: number | null;
    longitude?: number | null;
    location?: string | null;
    trafficStat?: string | null;
    description?: string | null;
    photos?: string[];
  };
  warnings: string[];
}

// Lightweight CSV parser that handles quoted fields with embedded commas
// and double-quote escapes. Pasted-from-Excel content lands here.
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuote && text[i + 1] === '"') {
        buf += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if ((c === '\n' || c === '\r') && !inQuote) {
      if (buf.length > 0 || lines.length === 0 || lines[lines.length - 1] !== '') lines.push(buf);
      buf = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) lines.push(buf);

  const rows = lines
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const cells: string[] = [];
      let cell = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (q && line[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            q = !q;
          }
          continue;
        }
        if (c === ',' && !q) {
          cells.push(cell);
          cell = '';
          continue;
        }
        cell += c;
      }
      cells.push(cell);
      return cells.map((c) => c.trim());
    });

  if (rows.length === 0) return { headers: [], rows: [] };
  return { headers: rows[0].map((h) => h.toLowerCase()), rows: rows.slice(1) };
}

// Map a CSV header to one of our known field names (case- and underscore-tolerant).
function normalizeField(h: string): string {
  const key = h.toLowerCase().replace(/[_\s]+/g, '');
  const map: Record<string, string> = {
    name: 'name',
    latitude: 'latitude',
    lat: 'latitude',
    longitude: 'longitude',
    lng: 'longitude',
    lon: 'longitude',
    location: 'location',
    address: 'location',
    trafficstat: 'trafficStat',
    traffic: 'trafficStat',
    reach: 'trafficStat',
    description: 'description',
    blurb: 'description',
    photos: 'photos',
    photo: 'photos',
    photourl: 'photos',
    photourls: 'photos',
    images: 'photos',
  };
  return map[key] ?? h;
}

function parseRow(headers: string[], cells: string[]): ParsedRow {
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    raw[h] = cells[i] ?? '';
  });
  const warnings: string[] = [];
  const get = (field: string): string | undefined => {
    for (const h of headers) {
      if (normalizeField(h) === field) {
        const v = raw[h];
        return v === '' ? undefined : v;
      }
    }
    return undefined;
  };

  const nameRaw = get('name');
  if (!nameRaw) warnings.push('missing "name" — row will be skipped');

  const parseLatLng = (key: string, min: number, max: number): number | null | undefined => {
    const v = get(key);
    if (v === undefined) return undefined;
    if (v === '' || v === '-') return null;
    const n = parseFloat(v);
    if (Number.isNaN(n)) {
      warnings.push(`${key}: "${v}" is not a number`);
      return undefined;
    }
    if (n < min || n > max) {
      warnings.push(`${key}: ${n} out of range [${min}, ${max}]`);
      return undefined;
    }
    return n;
  };

  const photosRaw = get('photos');
  let photos: string[] | undefined;
  if (photosRaw !== undefined) {
    photos = photosRaw
      .split(/[;|\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    const bad = photos.find((p) => !/^https?:\/\//i.test(p));
    if (bad) {
      warnings.push(`photo "${bad}" doesn't look like an http(s) URL`);
      photos = photos.filter((p) => /^https?:\/\//i.test(p));
    }
  }

  return {
    raw,
    parsed: {
      name: (nameRaw ?? '').trim(),
      latitude: parseLatLng('latitude', -90, 90),
      longitude: parseLatLng('longitude', -180, 180),
      location: get('location'),
      trafficStat: get('trafficStat'),
      description: get('description'),
      photos,
    },
    warnings,
  };
}

export default function DevicesBulkImport() {
  const [csv, setCsv] = useState(
    'name,latitude,longitude,traffic_stat,description,photos\n' +
      '"Tim Hortons",44.1252,-81.1500,"Seen by ~50K vehicles/week","Main intersection display","https://holmgraphics.ca/Images/LED_Sign_HHWalkerton.jpg"\n',
  );
  const [result, setResult] = useState<{
    matched: number;
    unmatched: number;
    errors: number;
    matchedRows: { name: string; id: string }[];
    unmatchedRows: string[];
    errorRows: { name: string; error: string }[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    const { headers, rows } = parseCsv(csv);
    if (headers.length === 0) return { headers, rows: [] as ParsedRow[] };
    return { headers, rows: rows.map((r) => parseRow(headers, r)) };
  }, [csv]);

  const applicable = parsed.rows.filter((r) => r.parsed.name);

  const apply = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await devicesApi.bulkImport(applicable.map((r) => r.parsed));
      setResult(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <Link to="/devices" className="muted" style={{ fontSize: 13 }}>← All devices</Link>
        <h1 style={{ margin: '4px 0 0' }}>Bulk import device marketing</h1>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Paste a CSV (from Excel / Sheets) to update lat/lng, location, traffic stat, description, and photo URLs across many devices at once.
          Devices are matched by exact <strong>name</strong>; nothing is created — only existing rows are updated.
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. Paste CSV</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Supported columns (case-insensitive, optional in any order): <code>name</code>, <code>latitude</code>, <code>longitude</code>, <code>location</code>, <code>traffic_stat</code>, <code>description</code>, <code>photos</code> (separate multiple URLs with <code>;</code>).
        </div>
        <textarea
          rows={10}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px 8px' }}>
          <h3 style={{ margin: 0 }}>2. Preview ({applicable.length} row{applicable.length === 1 ? '' : 's'})</h3>
        </div>
        {applicable.length === 0 ? (
          <div className="muted" style={{ textAlign: 'center', padding: 24, fontSize: 14 }}>
            No parseable rows yet.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Lat</th>
                <th>Lng</th>
                <th>Traffic</th>
                <th>Description</th>
                <th>Photos</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {applicable.map((r, i) => (
                <tr key={i}>
                  <td><strong>{r.parsed.name}</strong></td>
                  <td>{r.parsed.latitude ?? '—'}</td>
                  <td>{r.parsed.longitude ?? '—'}</td>
                  <td style={{ fontSize: 13 }}>{r.parsed.trafficStat ?? '—'}</td>
                  <td style={{ fontSize: 13, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.parsed.description ?? '—'}
                  </td>
                  <td style={{ fontSize: 12 }}>{r.parsed.photos ? `${r.parsed.photos.length} photo${r.parsed.photos.length === 1 ? '' : 's'}` : '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--yellow)' }}>
                    {r.warnings.length > 0 ? r.warnings.join('; ') : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={apply} disabled={busy || applicable.length === 0}>
          {busy ? 'Applying…' : `Apply to ${applicable.length} device${applicable.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {result && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Result</h3>
          <div className="row" style={{ gap: 24 }}>
            <div>
              <div className="muted" style={{ fontSize: 13 }}>Matched & updated</div>
              <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--green)' }}>{result.matched}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 13 }}>Unmatched names</div>
              <div style={{ fontSize: 24, fontWeight: 600, color: result.unmatched > 0 ? 'var(--yellow)' : undefined }}>{result.unmatched}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 13 }}>Errors</div>
              <div style={{ fontSize: 24, fontWeight: 600, color: result.errors > 0 ? 'var(--red)' : undefined }}>{result.errors}</div>
            </div>
          </div>
          {result.unmatchedRows.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 13 }}>No device found matching:</div>
              <div style={{ fontSize: 13 }}>{result.unmatchedRows.join(', ')}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Make sure the name matches a registered device exactly. If you're scoped to "All organizations",
                switch into the right org first.
              </div>
            </div>
          )}
          {result.errorRows.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 13 }}>Errors:</div>
              <ul style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 13 }}>
                {result.errorRows.map((e, i) => (
                  <li key={i}><strong>{e.name}:</strong> {e.error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { logs as logsApi } from '../api/endpoints';
import type { LogEntry } from '../types';

const LEVELS = ['', 'debug', 'info', 'warn', 'error'] as const;

const levelColor: Record<string, string> = {
  debug: 'var(--text-dim)',
  info: 'var(--text)',
  warn: 'var(--yellow)',
  error: 'var(--red)',
};

export default function Logs() {
  const [items, setItems] = useState<LogEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [level, setLevel] = useState<string>('');

  useEffect(() => {
    logsApi
      .list({ level: level || undefined, limit: 200 })
      .then(setItems)
      .catch((e) => setErr((e as Error).message));
  }, [level]);

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Logs</h1>
        <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: 160 }}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l || 'all levels'}</option>
          ))}
        </select>
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 180 }}>Time</th>
              <th style={{ width: 70 }}>Level</th>
              <th style={{ width: 80 }}>Source</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id}>
                <td className="muted">{new Date(l.ts).toLocaleString()}</td>
                <td style={{ color: levelColor[l.level], fontWeight: 500 }}>{l.level}</td>
                <td>{l.source}</td>
                <td>
                  {l.message}
                  {l.details && (
                    <pre style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-dim)' }}>
                      {JSON.stringify(l.details, null, 2)}
                    </pre>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No log entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

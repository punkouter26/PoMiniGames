import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiService } from '../games/shared/apiService';

interface DiagEntry {
  key: string;
  value: string;
  masked?: boolean;
}

function mask(value: string): string {
  if (!value || value.length <= 8) return '***';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function maskEntry(key: string, value: string): string {
  const sensitivePatterns = /secret|key|token|password|client.?id|scope/i;
  if (sensitivePatterns.test(key) && value.length > 8) return mask(value);
  return value;
}

export default function DiagPage() {
  const { config, user, isAuthenticated, isLoading, isConfigured } = useAuth();
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [backendDiag, setBackendDiag] = useState<Record<string, unknown> | null>(null);
  const [backendDiagError, setBackendDiagError] = useState<string | null>(null);

  useEffect(() => {
    const start = performance.now();
    apiService.isAvailable().then(ok => {
      setPingMs(Math.round(performance.now() - start));
      setApiStatus(ok ? 'online' : 'offline');
    });
  }, []);

  // Fetch the backend /diag endpoint if API is online
  useEffect(() => {
    if (apiStatus !== 'online') return;
    fetch('/diag', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => setBackendDiag(data as Record<string, unknown>))
      .catch((e: unknown) => setBackendDiagError(e instanceof Error ? e.message : String(e)));
  }, [apiStatus]);

  const envEntries: DiagEntry[] = Object.entries(import.meta.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      value: maskEntry(key, String(value ?? '')),
    }));

  const localStorageCount = (() => {
    try { return localStorage.length; } catch { return '?'; }
  })();

  const statusColor = {
    checking: '#f59e0b',
    online: '#22c55e',
    offline: '#ef4444',
  }[apiStatus];

  return (
    <div style={{ padding: '2rem', maxWidth: 860, margin: '0 auto', fontFamily: 'monospace', color: '#cdd5e0' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.25rem', color: '#fff' }}>🔧 /diag</h1>
      <p style={{ color: '#64748b', marginBottom: '2rem', fontSize: '0.8rem' }}>
        Diagnostic page — sensitive values are partially masked
      </p>

      {/* ── API Status ── */}
      <Section title="API Status">
        <Row label="Backend (localhost:5000)" value={<span style={{ color: statusColor }}>{apiStatus}{pingMs != null ? ` (${pingMs} ms)` : ''}</span>} />
        <Row label="Auth configured" value={String(isConfigured)} />
        <Row label="Auth loading" value={String(isLoading)} />
      </Section>

      {/* ── Auth ── */}
      <Section title="Auth">
        <Row label="Authenticated" value={String(isAuthenticated)} />
        <Row label="User ID" value={user?.userId ?? '—'} />
        <Row label="Display name" value={user?.displayName ?? '—'} />
        <Row label="Email" value={user?.email ? mask(user.email) : '—'} />
        {config && Object.entries(config).map(([k, v]) => (
          <Row key={k} label={`config.${k}`} value={maskEntry(k, String(v))} />
        ))}
      </Section>

      {/* ── Vite env ── */}
      <Section title="Vite Environment Variables">
        {envEntries.length === 0
          ? <Row label="(none)" value="" />
          : envEntries.map(e => <Row key={e.key} label={e.key} value={e.value} />)
        }
      </Section>

      {/* ── LocalStorage ── */}
      <Section title="Local Storage">
        <Row label="Entry count" value={String(localStorageCount)} />
      </Section>

      {/* ── Backend /diag ── */}
      <Section title="Backend /diag">
        {backendDiagError
          ? <p style={{ color: '#ef4444', margin: 0 }}>{backendDiagError}</p>
          : backendDiag == null
            ? <p style={{ color: '#64748b', margin: 0 }}>
                {apiStatus === 'offline' ? 'API offline' : 'Loading…'}
              </p>
            : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.75rem' }}>
                {JSON.stringify(backendDiag, null, 2)}
              </pre>
        }
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#94a3b8', borderBottom: '1px solid #1e293b', paddingBottom: '0.4rem', marginBottom: '0.75rem' }}>
        {title}
      </h2>
      <div style={{ display: 'grid', gap: '0.25rem' }}>
        {children}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1rem', fontSize: '0.8rem', lineHeight: 1.6 }}>
      <span style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ color: '#e2e8f0', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

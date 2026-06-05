import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';

const API_BASE = 'http://localhost:3001';
const POLL_INTERVAL_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-IN');
}

function formatPct(n) {
  if (n == null) return '0.0%';
  return `${Number(n).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  // ── Form state ──────────────────────────────────────────────────────────────
  const [file,            setFile]            = useState(null);
  const [subject,         setSubject]         = useState('');
  const [templateMessage, setTemplateMessage] = useState('');
  const [isDragging,      setIsDragging]      = useState(false);

  // ── CSV preview ─────────────────────────────────────────────────────────────
  const [previewRows,    setPreviewRows]    = useState([]);
  const [totalInFile,    setTotalInFile]    = useState(0);
  const [isPreview,      setIsPreview]      = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [filter,         setFilter]         = useState('all');

  // ── Job tracking ─────────────────────────────────────────────────────────────
  const [jobState,  setJobState]  = useState('idle');
  const [jobId,     setJobId]     = useState(null);
  const [jobStatus, setJobStatus] = useState(null);

  // ── Controls ──────────────────────────────────────────────────────────────────
  const [controlStatus, setControlStatus] = useState('running');
  const [smtpStats,     setSmtpStats]     = useState(null);

  // ── Feedback ─────────────────────────────────────────────────────────────────
  const [error,   setError]   = useState(null);
  const [success, setSuccess] = useState(null);

  const fileInputRef = useRef(null);
  const pollTimerRef = useRef(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Polling
  // ─────────────────────────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
  }, []);

  const startPolling = useCallback((id) => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API_BASE}/api/status/${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Status fetch failed');
        setJobStatus(data);
        if (data.controlStatus) setControlStatus(data.controlStatus);
        if (data.completed) {
          setJobState('completed');
          setSuccess(`All done! ${formatNumber(data.sent)} sent, ${formatNumber(data.failed)} failed out of ${formatNumber(data.total)} total.`);
          stopPolling();
        }
      } catch (err) {
        console.error('[POLL]', err.message);
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── SMTP Stats polling ─────────────────────────────────────────────────────
  useEffect(() => {
    const fetchSmtp = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/smtp-stats`);
        if (!res.ok) return;
        setSmtpStats(await res.json());
      } catch { /* ignore */ }
    };
    fetchSmtp();
    const t = setInterval(fetchSmtp, 5000);
    return () => clearInterval(t);
  }, []);

  // ── Job controls ───────────────────────────────────────────────────────────
  const handlePause = async () => {
    if (!jobId || controlStatus === 'stopped') return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/pause`, { method: 'POST' });
      const data = await res.json();
      if (data.success) setControlStatus('paused');
    } catch (err) { console.error('[CONTROL] Pause:', err.message); }
  };

  const handleResume = async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/resume`, { method: 'POST' });
      const data = await res.json();
      if (data.success) setControlStatus('running');
    } catch (err) { console.error('[CONTROL] Resume:', err.message); }
  };

  const handleStop = async () => {
    if (!jobId || controlStatus === 'stopped') return;
    if (!window.confirm('Stop this job? Unsent emails will be abandoned.')) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/stop`, { method: 'POST' });
      const data = await res.json();
      if (data.success) { setControlStatus('stopped'); stopPolling(); }
    } catch (err) { console.error('[CONTROL] Stop:', err.message); }
  };

  // ── File handlers ──────────────────────────────────────────────────────────
  const processFile = useCallback(async (selectedFile) => {
    setFile(selectedFile); setError(null); setSuccess(null);
    setLoadingPreview(true); setPreviewRows([]); setTotalInFile(0);
    setJobId(null); setJobStatus(null); setJobState('idle'); stopPolling();
    const fd = new FormData(); fd.append('file', selectedFile);
    try {
      const res  = await fetch(`${API_BASE}/api/parse-csv`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to parse CSV');
      setPreviewRows(data.recipients.map(r => ({ ...r, status: 'pending' })));
      setTotalInFile(data.totalInFile || data.recipients.length);
      setIsPreview(!!data.preview);
    } catch (err) { setError(err.message); setFile(null); }
    finally { setLoadingPreview(false); }
  }, [stopPolling]);

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f) f.name.endsWith('.csv') ? processFile(f) : setError('Please upload a valid CSV file.');
  };

  const handleDragOver  = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = ()  => setIsDragging(false);
  const handleDrop      = (e) => {
    e.preventDefault(); setIsDragging(false);
    if (isBusy) return;
    const f = e.dataTransfer.files[0];
    if (f) f.name.endsWith('.csv') ? processFile(f) : setError('Please upload a valid CSV file.');
  };

  const removeFile = () => {
    if (isBusy) return;
    setFile(null); setPreviewRows([]); setTotalInFile(0);
    setJobId(null); setJobStatus(null); setJobState('idle');
    setError(null); setSuccess(null); stopPolling();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSendEmails = async (e) => {
    e.preventDefault();
    if (!file || !subject.trim() || !templateMessage.trim()) return;
    if (isBusy) return;
    setError(null); setSuccess(null); setJobState('uploading');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('subject', subject.trim());
    fd.append('templateMessage', templateMessage.trim());
    try {
      const res  = await fetch(`${API_BASE}/api/upload-job`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setJobId(data.jobId);
      setJobStatus({ total: data.totalQueued, pending: data.totalQueued, sent: 0, failed: 0, processing: 0, percentage: 0 });
      setJobState('queued');
      startPolling(data.jobId);
      setSuccess(`${formatNumber(data.totalQueued)} emails queued across ${data.batches} batches. Worker is processing.`);
    } catch (err) { setError(err.message); setJobState('failed'); }
  };

  // ── Derived values ─────────────────────────────────────────────────────────
  const isBusy       = jobState === 'uploading' || jobState === 'queued';
  const progressPct  = jobStatus?.percentage ?? 0;
  const totalCount   = jobStatus?.total   ?? totalInFile;
  const sentCount    = jobStatus?.sent    ?? 0;
  const failedCount  = jobStatus?.failed  ?? 0;
  const pendingCount = jobStatus?.pending ?? previewRows.length;
  const procCount    = jobStatus?.processing ?? 0;

  const firstRecipient = previewRows.find(r => r.valid);
  const previewName    = firstRecipient?.name || 'John Doe';
  const previewBody    = templateMessage.trim()
    ? `Hi ${previewName} ${templateMessage.trim()}`
    : `Hi ${previewName} [Your message will appear here...]`;

  const filteredRows = previewRows.filter(r => filter === 'all' || r.status === filter);
  const showControls = jobId && progressPct > 0 && progressPct < 100;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Top Nav ─────────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-brand">
          <div className="brand-box" />
          <span className="brand-name">MAILGUN</span>
        </div>
        <div className="header-meta">
          <div className="conn-indicator">
            <span className="conn-dot" />
            <span className="conn-label">connected</span>
          </div>
          <div className="header-divider" />
          <button className="icon-btn" title="Sensor panel">
            <span className="material-symbols-outlined">sensors</span>
          </button>
        </div>
      </header>

      {/* Alert banners */}
      {(error || success) && (
        <div className="alert-notices">
          {error   && <div className="alert alert-danger"><strong>ERROR:</strong> {error}</div>}
          {success && <div className="alert alert-success">{success}</div>}
        </div>
      )}

      <main className="app-main">

        {/* ── Top Split ──────────────────────────────────────────────── */}
        <div className="top-split">

          {/* Left: Compose ────────────────────────────────────────────── */}
          <section className="compose-panel">
            <span className="section-label">Compose Mail</span>

            {/* CSV Upload */}
            {!file ? (
              <div
                className={`dropzone${isDragging ? ' active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="material-symbols-outlined">upload_file</span>
                <p className="dropzone-text">DRAG CSV OR <span>BROWSE</span></p>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".csv"
                  style={{ display: 'none' }}
                  disabled={isBusy}
                />
              </div>
            ) : (
              <div className="file-card">
                <div className="file-info">
                  <span className="file-icon">📄</span>
                  <div>
                    <div className="file-name">{file.name}</div>
                    <div className="file-size">
                      {(file.size / 1024).toFixed(2)} KB · {formatNumber(totalInFile)} entries
                      {isPreview ? ' (preview: first 200 shown)' : ' parsed'}
                    </div>
                  </div>
                </div>
                <button type="button" onClick={removeFile} className="btn-remove" disabled={isBusy}>✕</button>
              </div>
            )}

            {/* Inputs */}
            <div className="form-group">
              <div className="form-label-row">
                <label className="form-label" htmlFor="subject-input">SUBJECT</label>
                <span className="char-count">{subject.length} / 150</span>
              </div>
              <input
                id="subject-input"
                type="text"
                className="form-input"
                placeholder="Enter subject..."
                value={subject}
                onChange={e => setSubject(e.target.value)}
                maxLength={150}
                required
                disabled={isBusy}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="template-textarea">MESSAGE_BODY</label>
              <textarea
                id="template-textarea"
                className="form-textarea"
                placeholder="Write your message here..."
                value={templateMessage}
                onChange={e => setTemplateMessage(e.target.value)}
                required
                disabled={isBusy}
              />
            </div>

            {/* Live Preview */}
            <div className="form-group">
              <div className="preview-box">
                <div className="preview-meta">
                  <span>To: {firstRecipient ? firstRecipient.email : 'example@domain.com'}</span>
                  <span>LIVE PREVIEW</span>
                </div>
                <div className="preview-body">{previewBody}</div>
              </div>
            </div>

            <form onSubmit={handleSendEmails} style={{ marginTop: 'auto', display: 'contents' }}>
              <button
                type="submit"
                className="btn-execute"
                disabled={isBusy || loadingPreview || !file || !subject.trim() || !templateMessage.trim()}
              >
                {jobState === 'uploading' ? (
                  <><div className="spinner" /> UPLOADING &amp; QUEUING…</>
                ) : jobState === 'queued' ? (
                  <><div className="spinner" /> WORKER PROCESSING…</>
                ) : (
                  <><span className="material-symbols-outlined">send</span> EXECUTE</>
                )}
              </button>
            </form>
          </section>

          {/* Right: Monitor ────────────────────────────────────────────── */}
          <section className="monitor-panel">
            <div className="monitor-header">
              <span className="section-label">Execution Monitor</span>
              <div className="monitor-controls">
                <button
                  className="ctrl-btn pause-btn"
                  title="Pause"
                  onClick={handlePause}
                  disabled={!jobId || controlStatus === 'stopped' || controlStatus === 'paused' || !isBusy}
                >
                  <span className="material-symbols-outlined">pause</span>
                </button>
                <button
                  className="ctrl-btn resume-btn"
                  title="Resume"
                  onClick={handleResume}
                  disabled={!jobId || controlStatus !== 'paused'}
                >
                  <span className="material-symbols-outlined">play_arrow</span>
                </button>
                <button
                  className="ctrl-btn stop-btn"
                  title="Stop"
                  onClick={handleStop}
                  disabled={!jobId || controlStatus === 'stopped'}
                >
                  <span className="material-symbols-outlined">stop</span>
                </button>
              </div>
            </div>

            {/* Control status badges */}
            {showControls && (
              <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                {jobId && <div className="job-chip"><span className="job-chip-label">Job</span><span className="job-chip-value">{jobId}</span></div>}
                {controlStatus === 'paused'  && <span className="status-badge badge-paused">⏸ PAUSED</span>}
                {controlStatus === 'running' && isBusy && <span className="status-badge badge-running poll-dot">● RUNNING</span>}
                {controlStatus === 'stopped' && <span className="status-badge badge-stopped">■ STOPPED</span>}
              </div>
            )}
            {jobId && !showControls && progressPct >= 100 && (
              <div style={{ marginBottom: 12 }}>
                <div className="job-chip"><span className="job-chip-label">Job</span><span className="job-chip-value">{jobId}</span></div>
              </div>
            )}

            <div className="monitor-center">
              {/* Big pct */}
              <div className="big-pct">
                <span className="big-pct-value">{progressPct.toFixed(1)}%</span>
                <span className="big-pct-label">OPERATIONAL_LOAD</span>
              </div>

              {/* Progress bar */}
              <div className="progress-track" style={{ width: '100%', maxWidth: '100%' }}>
                <div className="progress-fill" style={{ width: `${progressPct}%` }} />
              </div>

              {/* Stats row */}
              <div className="stats-row" style={{ width: '100%', maxWidth: '100%' }}>
                <div className="stat-cell">
                  <span className="stat-lbl lbl-total">TOTAL</span>
                  <span className="stat-val">{formatNumber(totalCount)}</span>
                </div>
                <div className="stat-cell">
                  <span className="stat-lbl lbl-sent">SENT</span>
                  <span className="stat-val">{formatNumber(sentCount)}</span>
                </div>
                <div className="stat-cell">
                  <span className="stat-lbl lbl-failed">FAILED</span>
                  <span className="stat-val">{formatNumber(failedCount)}</span>
                </div>
                <div className="stat-cell">
                  <span className="stat-lbl lbl-pending">PENDING</span>
                  <span className="stat-val">{formatNumber(pendingCount + procCount)}</span>
                </div>
              </div>
            </div>

            {/* Recipients preview table */}
            {previewRows.length > 0 && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
                {isPreview && (
                  <div className="preview-notice">
                    ℹ SHOWING FIRST 200 OF {formatNumber(totalInFile)} TOTAL
                  </div>
                )}
                <div className="filter-tabs">
                  {['all','pending','sent','failed'].map(f => (
                    <button
                      key={f}
                      className={`filter-tab${filter === f ? ' active' : ''}`}
                      onClick={() => setFilter(f)}
                    >
                      {f.toUpperCase()} ({
                        f === 'all' ? previewRows.length :
                        previewRows.filter(r => r.status === f).length
                      })
                    </button>
                  ))}
                </div>
                <div className="recipients-list-container">
                  {filteredRows.length > 0 ? (
                    <table className="recipients-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.map(r => (
                          <tr key={r.id} className="recipient-row">
                            <td title={r.name}>{r.name || <em style={{ color: 'var(--outline)' }}>Empty</em>}</td>
                            <td title={r.email}>{r.email}</td>
                            <td>
                              {r.status === 'pending' && <span className="r-badge pending">⏱ Pending</span>}
                              {r.status === 'sent'    && <span className="r-badge sent">✓ Sent</span>}
                              {r.status === 'failed'  && <span className="r-badge failed" title={r.error || 'Failed'}>✕ Error</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="empty-state">
                      <span className="empty-icon">🔍</span>
                      <span className="empty-title">No recipients match this filter</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {previewRows.length === 0 && !loadingPreview && (
              <div className="empty-state" style={{ flex: 1 }}>
                <span className="empty-icon">📊</span>
                <span className="empty-title">No Recipients Loaded</span>
                <span className="empty-sub">Upload a CSV to see recipient status here.</span>
              </div>
            )}

            {loadingPreview && (
              <div className="empty-state" style={{ flex: 1 }}>
                <div className="spinner" style={{ margin: '0 auto' }} />
                <span className="empty-title">Parsing CSV…</span>
              </div>
            )}
          </section>
        </div>

        {/* ── SMTP Provider Cluster ──────────────────────────────────── */}
        <SmtpStatsPanel smtpStats={smtpStats} />

      </main>

      
    </div>
  );
}

// =============================================================================
// SmtpStatsPanel — SMTP Provider Pool Live Dashboard (unchanged logic)
// =============================================================================

function SmtpStatsPanel({ smtpStats }) {
  if (!smtpStats) {
    return (
      <section className="smtp-section">
        <div className="smtp-section-header">
          <span className="smtp-section-title">SMTP Provider Cluster (Active Pool)</span>
          <span className="smtp-lb-badge">LOAD_BALANCING: ACTIVE</span>
        </div>
        <div className="smtp-loading">
          <div className="spinner" />
          <span>Loading provider stats…</span>
        </div>
      </section>
    );
  }

  const { stats = [], totalCapacity = 0, totalSentToday = 0, totalRemaining = 0 } = smtpStats;
  const totalPct = totalCapacity > 0 ? Math.round((totalSentToday / totalCapacity) * 100) : 0;

  // Build pool bar segments
  const poolSegments = stats.map(s => ({
    name: s.provider,
    pct: totalCapacity > 0 ? ((s.sent / totalCapacity) * 100) : 0,
    color: (s.exhausted || s.pct >= 100) ? 'var(--error)'
         : s.pct >= 80                   ? 'var(--tertiary-fixed-dim)'
         :                                  'var(--primary-container)',
  }));

  return (
    <section className="smtp-section">
      <div className="smtp-section-header">
        <span className="smtp-section-title">SMTP Provider Cluster (Active Pool)</span>
        <span className="smtp-lb-badge">LOAD_BALANCING: ACTIVE</span>
      </div>

      <div className="smtp-scroll">
        {stats.length === 0 ? (
          <div className="smtp-loading">
            <span>No SMTP providers configured. Add credentials to .env to enable rotation.</span>
          </div>
        ) : (
          <table className="smtp-table">
            <thead className="smtp-table-head">
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Usage</th>
                <th style={{ width: '35%' }}>Throughput</th>
                <th>Load</th>
              </tr>
            </thead>
            <tbody className="smtp-table-body">
              {stats.map(s => {
                const isExhausted = s.exhausted || s.pct >= 100;
                const isWarn      = !isExhausted && s.pct >= 80;
                const statusClass = isExhausted ? 'status-done' : isWarn ? 'status-warn' : 'status-active';
                const statusLabel = isExhausted ? 'DONE' : isWarn ? 'LOW_BAL' : 'ACTIVE';
                const barColor    = isExhausted ? 'var(--outline)'
                                  : isWarn      ? 'var(--tertiary-fixed-dim)'
                                  :               'var(--primary-container)';
                return (
                  <tr key={s.provider}>
                    <td><span className="provider-name">{s.provider.toUpperCase()}</span></td>
                    <td>
                      <div className={`smtp-status ${statusClass}`}>
                        <span className="smtp-status-dot" />
                        <span className="smtp-status-label">{statusLabel}</span>
                      </div>
                    </td>
                    <td>{formatNumber(s.sent)} / {formatNumber(s.limit)}</td>
                    <td>
                      <div className="smtp-mini-bar">
                        <div className="smtp-mini-fill" style={{ width: `${Math.min(s.pct, 100)}%`, background: barColor }} />
                      </div>
                    </td>
                    <td>{s.pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      

      {/* Total pool summary (below legend) */}
      <div style={{ display: 'flex', gap: 24, padding: '8px 16px', borderTop: '1px solid var(--outline-variant)', background: 'var(--surface-container)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 10, color: 'var(--outline)', textTransform: 'uppercase' }}>Daily Capacity</span>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 14, fontWeight: 700, color: 'var(--on-surface)' }}>{formatNumber(totalCapacity)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 10, color: 'var(--outline)', textTransform: 'uppercase' }}>Sent Today</span>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 14, fontWeight: 700, color: 'var(--tertiary-fixed-dim)' }}>{formatNumber(totalSentToday)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 10, color: 'var(--outline)', textTransform: 'uppercase' }}>Remaining</span>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 14, fontWeight: 700, color: 'var(--primary)' }}>{formatNumber(totalRemaining)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 'auto' }}>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 10, color: 'var(--outline)', textTransform: 'uppercase' }}>Pool Usage</span>
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 14, fontWeight: 700, color: totalPct >= 80 ? 'var(--error)' : 'var(--on-surface)' }}>{totalPct}%</span>
        </div>
      </div>
    </section>
  );
}

export default App;

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

function StatusBadge({ status }) {
  const map = {
    idle:       { cls: 'badge-pending',  icon: '⏸',  label: 'Idle'        },
    uploading:  { cls: 'badge-sending',  icon: '📤', label: 'Uploading…'  },
    queued:     { cls: 'badge-sending',  icon: '⚡', label: 'Processing…' },
    completed:  { cls: 'badge-sent',     icon: '✓',  label: 'Completed'   },
    failed:     { cls: 'badge-failed',   icon: '✕',  label: 'Error'       },
  };
  const { cls, icon, label } = map[status] || map.idle;
  return <span className={`badge ${cls}`}>{icon} {label}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  // ── Form state ──────────────────────────────────────────────────────────────
  const [file,            setFile]            = useState(null);
  const [subject,         setSubject]         = useState('');
  const [templateMessage, setTemplateMessage] = useState('');
  const [isDragging,      setIsDragging]      = useState(false);

  // ── CSV preview (small sample for table display) ────────────────────────────
  const [previewRows,   setPreviewRows]   = useState([]);
  const [totalInFile,   setTotalInFile]   = useState(0);
  const [isPreview,     setIsPreview]     = useState(false);  // >200 rows trimmed
  const [loadingPreview,setLoadingPreview]= useState(false);
  const [filter,        setFilter]        = useState('all');

  // ── Job tracking ─────────────────────────────────────────────────────────────
  const [jobState, setJobState] = useState('idle');  // idle|uploading|queued|completed|failed
  const [jobId,    setJobId]    = useState(null);
  const [jobStatus,setJobStatus]= useState(null);    // { total, pending, sent, failed, percentage }

  // -- Controls (Task 5c) -------------------------------------------------------
  const [controlStatus, setControlStatus] = useState('running'); // 'running'|'paused'|'stopped'
  const [smtpStats,     setSmtpStats]     = useState(null);

  // ── Feedback ─────────────────────────────────────────────────────────────────
  const [error,   setError]   = useState(null);
  const [success, setSuccess] = useState(null);

  const fileInputRef = useRef(null);
  const pollTimerRef = useRef(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Polling: GET /api/status/:jobId every 2s until complete
  // ─────────────────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback((id) => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API_BASE}/api/status/${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Status fetch failed');

        setJobStatus(data);

        // Update control status from polling response (Task 3d + 5c)
        if (data.controlStatus) {
          setControlStatus(data.controlStatus);
        }

        if (data.completed) {
          setJobState('completed');
          setSuccess(
            `All done! ${formatNumber(data.sent)} sent, ${formatNumber(data.failed)} failed out of ${formatNumber(data.total)} total.`
          );
          stopPolling();
        }
      } catch (err) {
        console.error('[POLL] Status fetch error:', err.message);
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // -- SMTP Stats polling — polls every 5s from page mount regardless of job state
  useEffect(() => {
    const fetchSmtpStats = async () => {
      try {
        const res  = await fetch(`${API_BASE}/api/smtp-stats`);
        if (!res.ok) return;
        const data = await res.json();
        setSmtpStats(data);
      } catch {
        // Gracefully ignore errors — panel shows loading state
      }
    };
    fetchSmtpStats(); // immediate first fetch on mount
    const smtpTimer = setInterval(fetchSmtpStats, 5000);
    return () => clearInterval(smtpTimer);
  }, []); // empty deps — runs once on mount, polls continuously

  // -- Job control actions (Task 5b) -------------------------------------------
  const handlePause = async () => {
    if (!jobId || controlStatus === 'stopped') return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/pause`, { method: 'POST' });
      const data = await res.json();
      if (data.success) setControlStatus('paused');
    } catch (err) {
      console.error('[CONTROL] Pause failed:', err.message);
    }
  };

  const handleResume = async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/resume`, { method: 'POST' });
      const data = await res.json();
      if (data.success) setControlStatus('running');
    } catch (err) {
      console.error('[CONTROL] Resume failed:', err.message);
    }
  };

  const handleStop = async () => {
    if (!jobId || controlStatus === 'stopped') return;
    const confirmed = window.confirm('Stop this job? Unsent emails will be abandoned.');
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/stop`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setControlStatus('stopped');
        stopPolling();
      }
    } catch (err) {
      console.error('[CONTROL] Stop failed:', err.message);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // File handlers
  // ─────────────────────────────────────────────────────────────────────────

  const processFile = useCallback(async (selectedFile) => {
    setFile(selectedFile);
    setError(null);
    setSuccess(null);
    setLoadingPreview(true);
    setPreviewRows([]);
    setTotalInFile(0);
    setJobId(null);
    setJobStatus(null);
    setJobState('idle');
    stopPolling();

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const res  = await fetch(`${API_BASE}/api/parse-csv`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to parse CSV file');

      setPreviewRows(data.recipients.map(r => ({ ...r, status: 'pending' })));
      setTotalInFile(data.totalInFile || data.recipients.length);
      setIsPreview(!!data.preview);
    } catch (err) {
      setError(err.message);
      setFile(null);
    } finally {
      setLoadingPreview(false);
    }
  }, [stopPolling]);

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f) f.name.endsWith('.csv') ? processFile(f) : setError('Please upload a valid CSV file.');
  };

  const handleDragOver  = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = ()  => setIsDragging(false);
  const handleDrop      = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (jobState === 'uploading' || jobState === 'queued') return;
    const f = e.dataTransfer.files[0];
    if (f) f.name.endsWith('.csv') ? processFile(f) : setError('Please upload a valid CSV file.');
  };

  const removeFile = () => {
    if (jobState === 'uploading' || jobState === 'queued') return;
    setFile(null);
    setPreviewRows([]);
    setTotalInFile(0);
    setJobId(null);
    setJobStatus(null);
    setJobState('idle');
    setError(null);
    setSuccess(null);
    stopPolling();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Submit: POST /api/upload-job — fire-and-forget, returns jobId immediately
  // ─────────────────────────────────────────────────────────────────────────

  const handleSendEmails = async (e) => {
    e.preventDefault();
    if (!file || !subject.trim() || !templateMessage.trim()) return;
    if (jobState === 'uploading' || jobState === 'queued') return;

    setError(null);
    setSuccess(null);
    setJobState('uploading');

    const formData = new FormData();
    formData.append('file',            file);
    formData.append('subject',         subject.trim());
    formData.append('templateMessage', templateMessage.trim());

    try {
      const res  = await fetch(`${API_BASE}/api/upload-job`, { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Upload failed');

      setJobId(data.jobId);
      setJobStatus({ total: data.totalQueued, pending: data.totalQueued, sent: 0, failed: 0, processing: 0, percentage: 0 });
      setJobState('queued');
      startPolling(data.jobId);

      setSuccess(`📬 File accepted! ${formatNumber(data.totalQueued)} emails queued across ${data.batches} batches. Worker is processing in the background.`);
    } catch (err) {
      setError(err.message);
      setJobState('failed');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Derived values
  // ─────────────────────────────────────────────────────────────────────────

  const isBusy        = jobState === 'uploading' || jobState === 'queued';
  const progressPct   = jobStatus?.percentage ?? 0;
  const totalCount    = jobStatus?.total  ?? totalInFile;
  const sentCount     = jobStatus?.sent   ?? 0;
  const failedCount   = jobStatus?.failed ?? 0;
  const pendingCount  = jobStatus?.pending  ?? previewRows.length;
  const procCount     = jobStatus?.processing ?? 0;

  const firstRecipient = previewRows.find(r => r.valid);
  const previewName    = firstRecipient?.name || 'John Doe';
  const previewBody    = templateMessage.trim()
    ? `Hi ${previewName} ${templateMessage.trim()}`
    : `Hi ${previewName} [Your message will appear here...]`;

  const filteredRows = previewRows.filter(r => {
    if (filter === 'all') return true;
    return r.status === filter;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Bulk Personalized Email Sender</h1>
        <p>Upload a CSV list of recipients, compose your message template, and dispatch personalized emails to up to <strong>800,000 users</strong> — asynchronously, without timeouts.</p>
      </header>

      {error && (
        <div className="alert alert-danger">
          <strong>Error:</strong> {error}
        </div>
      )}
      {success && (
        <div className="alert alert-success">
          {success}
        </div>
      )}

      <div className="app-grid">
        {/* ── Composer ─────────────────────────────────────────────────── */}
        <form onSubmit={handleSendEmails} className="card">
          <h2 className="card-title">
            <span style={{ marginRight: '0.25rem' }}>✉️</span> Compose Broadcast
          </h2>

          {/* CSV Upload */}
          <div className="form-group">
            <span className="form-label">Recipient List (CSV)</span>
            {!file ? (
              <div
                className={`dropzone ${isDragging ? 'active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="dropzone-icon">📥</div>
                <div className="dropzone-text">Drag &amp; drop your CSV here, or click to browse</div>
                <div className="dropzone-hint">Must contain "name" and "email" columns · Supports 800K+ rows</div>
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
                  <span style={{ fontSize: '1.5rem' }}>📄</span>
                  <div>
                    <div className="file-name">{file.name}</div>
                    <div className="file-size">
                      {(file.size / 1024).toFixed(2)} KB ·{' '}
                      {formatNumber(totalInFile)} entries{isPreview ? ' (preview: first 200 shown)' : ' parsed'}
                    </div>
                  </div>
                </div>
                <button type="button" onClick={removeFile} className="btn-remove" title="Remove CSV" disabled={isBusy}>
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* Subject */}
          <div className="form-group">
            <label className="form-label" htmlFor="subject-input">Subject Line</label>
            <input
              id="subject-input"
              type="text"
              className="form-input"
              placeholder="e.g., Invitation to Exposys Coding Round"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              required
              disabled={isBusy}
            />
          </div>

          {/* Template */}
          <div className="form-group">
            <label className="form-label" htmlFor="template-textarea">Message Template</label>
            <textarea
              id="template-textarea"
              className="form-textarea"
              placeholder="e.g., welcome to Exposys Data Lab coding round"
              value={templateMessage}
              onChange={e => setTemplateMessage(e.target.value)}
              required
              disabled={isBusy}
            />
            <p className="dropzone-hint">"Hi [Name] " will be automatically prepended for each recipient.</p>
          </div>

          {/* Live Preview */}
          <div className="form-group">
            <span className="form-label">Personalization Preview</span>
            <div className="preview-container">
              <div className="preview-header">
                <span>Sending to: {firstRecipient ? firstRecipient.email : 'example@domain.com'}</span>
                <span>Live Preview</span>
              </div>
              <div className="preview-body">{previewBody}</div>
            </div>
          </div>

          {/* Architecture note */}
          <div className="arch-note">
            <span className="arch-note-icon">⚡</span>
            <span>
              <strong>Async Architecture:</strong> The CSV is streamed in 5,000-row chunks into a Redis queue.
              Emails are sent by a background worker with rate limiting &amp; retry — your browser won't block or time out.
            </span>
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={isBusy || loadingPreview || !file || !subject.trim() || !templateMessage.trim()}
          >
            {jobState === 'uploading' ? (
              <><div className="spinner"></div> Uploading &amp; Queuing…</>
            ) : jobState === 'queued' ? (
              <><div className="spinner"></div> Worker Processing in Background…</>
            ) : (
              <>🚀 Send Personalized Emails</>
            )}
          </button>
        </form>

        {/* ── Status Tracker ───────────────────────────────────────────── */}
        <div className="card">
          <h2 className="card-title">
            <span style={{ marginRight: '0.25rem' }}>📊</span> Delivery Status Tracker
            {jobId && (
              <StatusBadge status={jobState} />
            )}
          </h2>

          {/* Job ID chip */}
          {jobId && (
            <div className="job-id-chip">
              <span className="job-id-label">Job ID</span>
              <code className="job-id-value">{jobId}</code>
            </div>
          )}

          {/* Stats grid */}
          <div className="stats-grid">
            <div className="stat-card total">
              <div className="stat-val">{formatNumber(totalCount)}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat-card pending">
              <div className="stat-val">{formatNumber(pendingCount + procCount)}</div>
              <div className="stat-label">Pending</div>
            </div>
            <div className="stat-card sent">
              <div className="stat-val">{formatNumber(sentCount)}</div>
              <div className="stat-label">Sent</div>
            </div>
            <div className="stat-card failed">
              <div className="stat-val">{formatNumber(failedCount)}</div>
              <div className="stat-label">Failed</div>
            </div>
          </div>

          {/* Progress bar */}
          {(isBusy || jobState === 'completed') && (
            <div className="progress-container">
              <div className="progress-header">
                <span>
                  Progress
                  {isBusy && <span className="polling-indicator"> · polling every 2s</span>}
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="progress-bar-bg">
                <div
                  className={`progress-bar-fill ${jobState === 'completed' ? 'progress-complete' : ''}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="progress-sub">
                {formatNumber(sentCount + failedCount)} / {formatNumber(totalCount)} processed
                {procCount > 0 && <span className="proc-badge"> · {formatNumber(procCount)} sending now</span>}
              </div>
            </div>
          )}

          {/* Pause / Resume / Stop controls (Task 5b) */}
          {jobId && progressPct > 0 && progressPct < 100 && (
            <div className="job-controls">
              {controlStatus === 'paused' && (
                <span className="control-badge paused-badge">PAUSED</span>
              )}
              {controlStatus !== 'stopped' && controlStatus !== 'paused' && (
                <button
                  id="btn-pause-job"
                  className="btn-control btn-pause"
                  onClick={handlePause}
                  disabled={controlStatus === 'stopped'}
                  title="Pause sending"
                >
                  Pause
                </button>
              )}
              {controlStatus === 'paused' && (
                <button
                  id="btn-resume-job"
                  className="btn-control btn-resume"
                  onClick={handleResume}
                  title="Resume sending"
                >
                  Resume
                </button>
              )}
              {controlStatus !== 'stopped' && (
                <button
                  id="btn-stop-job"
                  className="btn-control btn-stop"
                  onClick={handleStop}
                  title="Stop job permanently"
                >
                  Stop
                </button>
              )}
              {controlStatus === 'stopped' && (
                <span className="control-badge stopped-badge">STOPPED</span>
              )}
            </div>
          )}

          {/* Filter tabs (preview table) */}
          {previewRows.length > 0 && (
            <>
              {isPreview && (
                <div className="preview-notice">
                  ℹ️ Showing first 200 rows of {formatNumber(totalInFile)} total. Full batch is queued for processing.
                </div>
              )}
              <div className="list-controls">
                <div className="filter-tabs">
                  {['all','pending','sent','failed'].map(f => (
                    <button
                      key={f}
                      className={`filter-tab ${filter === f ? 'active' : ''}`}
                      onClick={() => setFilter(f)}
                    >
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                      {f === 'all'     && ` (${previewRows.length})`}
                      {f === 'pending' && ` (${previewRows.filter(r => r.status === 'pending').length})`}
                      {f === 'sent'    && ` (${previewRows.filter(r => r.status === 'sent').length})`}
                      {f === 'failed'  && ` (${previewRows.filter(r => r.status === 'failed').length})`}
                    </button>
                  ))}
                </div>
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
                          <td title={r.name}>{r.name || <em style={{ color: 'var(--text-muted)' }}>Empty</em>}</td>
                          <td title={r.email}>{r.email}</td>
                          <td>
                            {r.status === 'pending' && <span className="badge badge-pending">⏱️ Pending</span>}
                            {r.status === 'sent'    && <span className="badge badge-sent">✓ Sent</span>}
                            {r.status === 'failed'  && <span className="badge badge-failed" title={r.error || 'Failed'}>✕ Error</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="empty-state">
                    <span className="empty-state-icon">🔍</span>
                    <strong>No recipients match this filter.</strong>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Empty state */}
          {previewRows.length === 0 && !loadingPreview && (
            <div className="empty-state">
              <span className="empty-state-icon">📊</span>
              <strong>No Recipients Loaded</strong>
              <span className="dropzone-hint">Upload a valid CSV file to preview recipient status here.</span>
            </div>
          )}

          {loadingPreview && (
            <div className="empty-state">
              <div className="spinner" style={{ margin: '0 auto' }}></div>
              <strong>Parsing CSV…</strong>
            </div>
          )}
        </div>
      </div>

      {/* SMTP Provider Pool — full-width panel below the two-column grid (Task 5a) */}
      <SmtpStatsPanel smtpStats={smtpStats} />
    </div>
  );
}

// =============================================================================
// SmtpStatsPanel — SMTP Provider Pool Live Dashboard (Task 5a)
// =============================================================================

function SmtpStatsPanel({ smtpStats }) {
  if (!smtpStats) {
    return (
      <div className="card smtp-stats-card">
        <h2 className="card-title">
          <span style={{ marginRight: '0.25rem' }}>📡</span> SMTP Provider Pool
        </h2>
        <div className="empty-state">
          <div className="spinner" style={{ margin: '0 auto' }}></div>
          <strong>Loading provider stats…</strong>
        </div>
      </div>
    );
  }

  const { stats = [], totalCapacity = 0, totalSentToday = 0, totalRemaining = 0 } = smtpStats;
  const totalPct = totalCapacity > 0 ? Math.round((totalSentToday / totalCapacity) * 100) : 0;

  return (
    <div className="card smtp-stats-card">
      <h2 className="card-title">
        <span style={{ marginRight: '0.25rem' }}>📡</span> SMTP Provider Pool
      </h2>

      {/* Summary totals */}
      <div className="smtp-summary-row">
        <div className="smtp-summary-item">
          <div className="smtp-summary-val">{formatNumber(totalCapacity)}</div>
          <div className="smtp-summary-label">Daily Capacity</div>
        </div>
        <div className="smtp-summary-item">
          <div className="smtp-summary-val smtp-sent-val">{formatNumber(totalSentToday)}</div>
          <div className="smtp-summary-label">Sent Today</div>
        </div>
        <div className="smtp-summary-item">
          <div className="smtp-summary-val smtp-remain-val">{formatNumber(totalRemaining)}</div>
          <div className="smtp-summary-label">Remaining</div>
        </div>
      </div>

      {/* Total pool progress bar */}
      <div className="smtp-total-bar-container">
        <div className="smtp-total-bar-header">
          <span>Total Pool Usage</span>
          <span>{totalPct}%</span>
        </div>
        <div className="progress-bar-bg">
          <div
            className="progress-bar-fill smtp-total-fill"
            style={{
              width: `${totalPct}%`,
              background: totalPct >= 100 ? '#ef4444'
                        : totalPct >= 80  ? '#f59e0b'
                        :                   'linear-gradient(90deg, #6366f1, #8b5cf6)',
              transition: 'width 0.6s ease',
            }}
          />
        </div>
      </div>

      {/* Per-provider rows */}
      {stats.length === 0 ? (
        <div className="smtp-no-providers">
          No SMTP providers configured. Add credentials to .env to enable rotation.
        </div>
      ) : (
        <div className="smtp-providers-list">
          {stats.map((s) => {
            const statusColor = (s.exhausted || s.pct >= 100) ? '#ef4444'
                              : s.pct >= 80                   ? '#f59e0b'
                              :                                  '#22c55e';
            const barColor    = (s.exhausted || s.pct >= 100) ? '#ef4444'
                              : s.pct >= 80                   ? '#f59e0b'
                              :                                  'linear-gradient(90deg, #6366f1, #22c55e)';
            return (
              <div key={s.provider} className="smtp-provider-row">
                <div className="smtp-provider-header">
                  <div className="smtp-provider-name-group">
                    <span
                      className="smtp-status-dot"
                      style={{ background: statusColor }}
                      title={(s.exhausted || s.pct >= 100) ? 'Exhausted' : s.pct >= 80 ? 'Near limit' : 'Available'}
                    />
                    <span className="smtp-provider-name">{s.provider}</span>
                  </div>
                  <div className="smtp-provider-counts">
                    <span className="smtp-count-sent">{s.sent}</span>
                    <span className="smtp-count-sep"> / </span>
                    <span className="smtp-count-limit">{s.limit}</span>
                    <span className="smtp-count-pct">({s.pct}%)</span>
                  </div>
                </div>
                <div className="progress-bar-bg smtp-provider-bar-bg">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${s.pct}%`, background: barColor, transition: 'width 0.6s ease' }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default App;


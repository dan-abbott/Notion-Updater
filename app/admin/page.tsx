'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

type ConnectorConfig = {
  notionPageId: string;
  appsScriptUrl: string;
};

export default function AdminPage() {
  return (
    <Suspense fallback={<main className="wrap"><p>Loading…</p></main>}>
      <AdminPageContent />
    </Suspense>
  );
}

function AdminPageContent() {
  const searchParams = useSearchParams();

  const [connectors, setConnectors] = useState<Record<string, ConnectorConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectorId, setConnectorId] = useState('');
  const [notionPageId, setNotionPageId] = useState('');
  const [appsScriptUrl, setAppsScriptUrl] = useState('');
  const [editingExistingId, setEditingExistingId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadConnectors() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/connectors');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load connectors.');
      setConnectors(data.connectors);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadConnectors();
    // Prefill the form if arriving from the setup wizard with values ready to go.
    const prefillId = searchParams.get('connectorId');
    const prefillPageId = searchParams.get('notionPageId');
    const prefillUrl = searchParams.get('appsScriptUrl');
    if (prefillId) setConnectorId(prefillId);
    if (prefillPageId) setNotionPageId(prefillPageId);
    if (prefillUrl) setAppsScriptUrl(prefillUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startEdit(id: string, config: ConnectorConfig) {
    setEditingExistingId(id);
    setConnectorId(id);
    setNotionPageId(config.notionPageId);
    setAppsScriptUrl(config.appsScriptUrl);
    setSaveError(null);
  }

  function resetForm() {
    setEditingExistingId(null);
    setConnectorId('');
    setNotionPageId('');
    setAppsScriptUrl('');
    setSaveError(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/admin/connectors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectorId: connectorId.trim(),
          notionPageId: notionPageId.trim(),
          appsScriptUrl: appsScriptUrl.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save connector.');
      setConnectors(data.connectors);
      resetForm();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(`Remove connector "${id}"? This commits directly to the repo.`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/connectors?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete connector.');
      setConnectors(data.connectors);
      if (editingExistingId === id) resetForm();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Unknown error deleting connector.');
    } finally {
      setDeletingId(null);
    }
  }

  const isFormValid = connectorId.trim() && notionPageId.trim() && appsScriptUrl.trim();
  const isRenaming = editingExistingId && editingExistingId !== connectorId.trim();

  return (
    <main className="wrap">
      <h1>Connector Admin</h1>
      <p className="lede">
        Add, edit, or remove connectors here — this commits directly to <code>connectors.json</code> in the repo, so
        nobody needs GitHub access just to register a new page.
      </p>

      {loading && <p className="hint">Loading connectors…</p>}
      {loadError && <p className="error">{loadError}</p>}

      {connectors && (
        <table className="connectorTable">
          <thead>
            <tr>
              <th>Connector ID</th>
              <th>Notion Page ID</th>
              <th>Apps Script URL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(connectors).map(([id, config]) => (
              <tr key={id}>
                <td className="mono">{id}</td>
                <td className="mono truncate">{config.notionPageId}</td>
                <td className="mono truncate">{config.appsScriptUrl}</td>
                <td className="actions">
                  <button className="small ghost" onClick={() => startEdit(id, config)}>
                    Edit
                  </button>
                  <button className="small danger" onClick={() => handleDelete(id)} disabled={deletingId === id}>
                    {deletingId === id ? 'Removing…' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}
            {Object.keys(connectors).length === 0 && (
              <tr>
                <td colSpan={4} className="hint">
                  No connectors yet — add the first one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <h2>{editingExistingId ? `Editing "${editingExistingId}"` : 'Add a connector'}</h2>
      {isRenaming && (
        <p className="hint">
          Changing the ID here adds a NEW connector "{connectorId.trim()}" rather than renaming this one — remove the
          old one separately if that's not what you want.
        </p>
      )}
      <label className="field">
        Connector ID
        <input type="text" value={connectorId} onChange={e => setConnectorId(e.target.value)} placeholder="e.g. team-b" />
      </label>
      <label className="field">
        Notion Page ID
        <input
          type="text"
          value={notionPageId}
          onChange={e => setNotionPageId(e.target.value)}
          placeholder="e.g. 3987faa6-6864-80f3-82c3-fff70d2e0826"
        />
      </label>
      <label className="field">
        Apps Script URL
        <input
          type="text"
          value={appsScriptUrl}
          onChange={e => setAppsScriptUrl(e.target.value)}
          placeholder="https://script.google.com/macros/s/.../exec"
        />
      </label>

      <div className="row">
        <button onClick={handleSave} disabled={!isFormValid || saving}>
          {saving ? 'Saving…' : editingExistingId ? 'Save changes' : 'Add connector'}
        </button>
        {editingExistingId && (
          <button className="ghost" onClick={resetForm}>
            Cancel
          </button>
        )}
      </div>
      {saveError && <p className="error">{saveError}</p>}

      <style jsx global>{`
        .wrap {
          max-width: 900px;
          margin: 0 auto;
          padding: 40px 24px 80px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #1a1a1a;
        }
        h1 {
          font-size: 26px;
          margin-bottom: 4px;
        }
        h2 {
          font-size: 16px;
          margin: 28px 0 12px;
        }
        .lede {
          color: #555;
          margin-bottom: 24px;
          max-width: 64ch;
        }
        .hint {
          color: #666;
          font-size: 13px;
          margin: 6px 0 12px;
        }
        .error {
          color: #b3261e;
          font-size: 13px;
          margin: 8px 0;
        }
        .connectorTable {
          border-collapse: separate;
          border-spacing: 0;
          width: 100%;
          font-size: 13px;
          background: white;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(30, 30, 60, 0.08);
          margin-bottom: 24px;
        }
        .connectorTable th,
        .connectorTable td {
          padding: 10px 12px;
          border-bottom: 1px solid #eee;
          text-align: left;
        }
        .connectorTable th {
          background: #f4f6fb;
          color: #33396b;
        }
        .connectorTable tr:last-child td {
          border-bottom: none;
        }
        .mono {
          font-family: monospace;
          font-size: 12px;
        }
        .truncate {
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .actions {
          display: flex;
          gap: 6px;
          justify-content: flex-end;
        }
        .field {
          display: block;
          font-size: 13px;
          color: #333;
          margin-bottom: 14px;
        }
        .field input {
          display: block;
          width: 100%;
          margin-top: 4px;
          padding: 8px 10px;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 14px;
          box-sizing: border-box;
        }
        .row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        button {
          padding: 8px 14px;
          border-radius: 6px;
          border: none;
          background: #1a1a1a;
          color: white;
          font-size: 14px;
          cursor: pointer;
          white-space: nowrap;
        }
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        button.small {
          padding: 4px 10px;
          font-size: 12px;
        }
        button.ghost {
          background: transparent;
          color: #666;
          border: 1px solid #ddd;
        }
        button.danger {
          background: transparent;
          color: #b3261e;
          border: 1px solid #f0c9c5;
        }
      `}</style>
    </main>
  );
}

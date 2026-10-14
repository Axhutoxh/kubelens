import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  X, 
  FileText, 
  Copy, 
  Check, 
  Plus, 
  Trash2, 
  Save, 
  RotateCcw, 
  Search, 
  AlertCircle, 
  CheckCircle2, 
  Loader2,
  FileCode,
  Tag
} from 'lucide-react';
import { ConfigMapItem } from '../types/k8s';
import { applyManifest } from '../api/client';

interface ConfigKeyEntry {
  id: string;
  originalKey: string;
  key: string;
  value: string;
  originalValue: string;
  isNew?: boolean;
}

interface ConfigMapDetailModalProps {
  isOpen: boolean;
  configMap: ConfigMapItem | null;
  context?: string;
  onClose: () => void;
  onRefreshList?: () => void;
  onOpenManifest?: (kind: string, name: string, namespace: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export const ConfigMapDetailModal: React.FC<ConfigMapDetailModalProps> = ({
  isOpen,
  configMap,
  context,
  onClose,
  onRefreshList,
  onOpenManifest,
  onToast,
}) => {
  if (!isOpen || !configMap) return null;

  const [activeTab, setActiveTab] = useState<'data' | 'metadata'>('data');
  const [entries, setEntries] = useState<ConfigKeyEntry[]>([]);
  const [searchKey, setSearchKey] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Initialize entries from configMap data
  useEffect(() => {
    if (!configMap) return;
    const rawData = configMap.data || {};
    const initial: ConfigKeyEntry[] = Object.entries(rawData).map(([k, val], idx) => ({
      id: `key-${idx}-${k}`,
      originalKey: k,
      key: k,
      value: val || '',
      originalValue: val || '',
    }));
    setEntries(initial);
    setSaveError(null);
    setSaveSuccess(false);
  }, [configMap]);

  const hasChanges = useMemo(() => {
    const rawData = configMap.data || {};
    const originalKeys = Object.keys(rawData);
    if (entries.length !== originalKeys.length) return true;

    return entries.some(
      (e) => e.isNew || e.key !== e.originalKey || e.value !== e.originalValue
    );
  }, [entries, configMap]);

  const filteredEntries = useMemo(() => {
    if (!searchKey.trim()) return entries;
    const q = searchKey.toLowerCase();
    return entries.filter(
      (e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)
    );
  }, [entries, searchKey]);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleAddKey = () => {
    const newId = `new-${Date.now()}`;
    setEntries((prev) => [
      ...prev,
      {
        id: newId,
        originalKey: '',
        key: 'NEW_KEY',
        value: '',
        originalValue: '',
        isNew: true,
      },
    ]);
  };

  const handleRemoveKey = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const handleKeyChange = (id: string, newKey: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, key: newKey } : e))
    );
  };

  const handleValueChange = (id: string, newVal: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, value: newVal } : e))
    );
  };

  const handleReset = () => {
    const rawData = configMap.data || {};
    const initial: ConfigKeyEntry[] = Object.entries(rawData).map(([k, val], idx) => ({
      id: `key-${idx}-${k}`,
      originalKey: k,
      key: k,
      value: val || '',
      originalValue: val || '',
    }));
    setEntries(initial);
    setSaveError(null);
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setSaveError(null);

      // Validate duplicate keys
      const keysSeen = new Set<string>();
      for (const e of entries) {
        const k = e.key.trim();
        if (!k) throw new Error('Key names cannot be blank');
        if (keysSeen.has(k)) throw new Error(`Duplicate key detected: "${k}"`);
        keysSeen.add(k);
      }

      // Build data dictionary
      const dataObj: Record<string, string> = {};
      for (const e of entries) {
        dataObj[e.key.trim()] = e.value;
      }

      const manifestObj = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: configMap.metadata.name,
          namespace: configMap.metadata.namespace || 'default',
          labels: configMap.metadata.labels,
          annotations: configMap.metadata.annotations,
        },
        data: dataObj,
      };

      const manifestYaml = JSON.stringify(manifestObj, null, 2);
      await applyManifest(manifestYaml, context);

      setSaveSuccess(true);
      if (onToast) onToast(`ConfigMap "${configMap.metadata.name}" saved successfully`);
      if (onRefreshList) onRefreshList();
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save ConfigMap');
      if (onToast) onToast(err.message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-950/80 border border-cyan-800/80 flex items-center justify-center text-cyan-400">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-100 font-mono">
                  {configMap.metadata.name}
                </h2>
                <span className="bg-slate-800 text-slate-400 px-2 py-0.2 rounded text-[11px] font-mono">
                  {configMap.metadata.namespace || 'default'}
                </span>
                {context && (
                  <span className="bg-cyan-950/60 text-cyan-300 border border-cyan-800/60 text-[10px] px-1.5 py-0.2 rounded font-sans">
                    {context}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                ConfigMap Data Keys & Configuration Values
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onOpenManifest && (
              <button
                onClick={() =>
                  onOpenManifest(
                    'configmaps',
                    configMap.metadata.name,
                    configMap.metadata.namespace || 'default'
                  )
                }
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors cursor-pointer"
              >
                <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                <span>YAML</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab & Search Bar */}
        <div className="px-6 py-2.5 border-b border-slate-800 bg-slate-950/40 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('data')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
                activeTab === 'data'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Data Values ({entries.length})
            </button>
            <button
              onClick={() => setActiveTab('metadata')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
                activeTab === 'metadata'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Metadata & Labels
            </button>
          </div>

          {activeTab === 'data' && (
            <div className="flex items-center gap-2 flex-1 max-w-xs ml-auto">
              <div className="relative w-full">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
                <input
                  type="text"
                  placeholder="Filter keys or values..."
                  value={searchKey}
                  onChange={(e) => setSearchKey(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700/80 rounded-md pl-8 pr-3 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <button
                onClick={handleAddKey}
                className="flex items-center gap-1 px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold rounded text-xs transition-colors shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Key</span>
              </button>
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {activeTab === 'data' && (
            <>
              {filteredEntries.length === 0 ? (
                <div className="py-12 text-center text-slate-500 italic text-xs">
                  {searchKey ? 'No keys matching query.' : 'This ConfigMap contains no data keys.'}
                </div>
              ) : (
                filteredEntries.map((entry) => {
                  const isModified =
                    entry.isNew ||
                    entry.key !== entry.originalKey ||
                    entry.value !== entry.originalValue;

                  return (
                    <div
                      key={entry.id}
                      className={`border rounded-lg p-3 bg-slate-950/60 transition-colors ${
                        isModified ? 'border-amber-500/60' : 'border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 flex-1 max-w-md">
                          <input
                            type="text"
                            value={entry.key}
                            onChange={(e) => handleKeyChange(entry.id, e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs font-mono font-semibold text-cyan-300 w-full focus:outline-none focus:border-cyan-500"
                            placeholder="KEY_NAME"
                          />
                          {isModified && (
                            <span className="text-[10px] text-amber-400 font-semibold shrink-0">
                              (Modified)
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 font-sans">
                          <button
                            onClick={() => handleCopy(entry.value, entry.id)}
                            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="Copy Value"
                          >
                            {copiedKey === entry.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => handleRemoveKey(entry.id)}
                            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete Key"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Multiline Value Editor */}
                      <textarea
                        value={entry.value}
                        onChange={(e) => handleValueChange(entry.id, e.target.value)}
                        rows={Math.min(10, Math.max(3, entry.value.split('\n').length))}
                        className="w-full bg-slate-900/90 border border-slate-800 rounded-md p-2.5 font-mono text-xs text-slate-200 focus:outline-none focus:border-cyan-500 resize-y leading-relaxed"
                        placeholder="Configuration value..."
                      />
                    </div>
                  );
                })
              )}
            </>
          )}

          {activeTab === 'metadata' && (
            <div className="space-y-4 text-xs font-mono">
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2">
                <div className="text-slate-400 font-semibold mb-2 font-sans">Metadata Details</div>
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-500">Name:</span>
                  <span className="text-slate-200">{configMap.metadata.name}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-500">Namespace:</span>
                  <span className="text-slate-200">{configMap.metadata.namespace}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800/80 pb-1.5">
                  <span className="text-slate-500">UID:</span>
                  <span className="text-slate-400">{configMap.metadata.uid || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Created:</span>
                  <span className="text-slate-400">{configMap.metadata.creationTimestamp}</span>
                </div>
              </div>

              {configMap.metadata.labels && (
                <div className="bg-slate-950 p-4 rounded-lg border border-slate-800">
                  <div className="text-slate-400 font-semibold mb-2 font-sans flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Labels</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(configMap.metadata.labels).map(([k, v]) => (
                      <span
                        key={k}
                        className="bg-slate-900 border border-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px]"
                      >
                        <span className="text-cyan-400">{k}</span>: {v}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs">
            {saveSuccess && (
              <span className="text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Saved successfully!</span>
              </span>
            )}
            {saveError && (
              <span className="text-rose-400 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{saveError}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {hasChanges && (
              <button
                onClick={handleReset}
                disabled={isSaving}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:hover:bg-cyan-600 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save ConfigMap</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

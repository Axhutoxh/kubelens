import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  FileText,
  Copy,
  Check,
  Plus,
  Trash2,
  Save,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileCode,
  Tag,
  ArrowLeft
} from 'lucide-react';
import { ConfigMapItem } from '../types/k8s';
import { applyManifest } from '../api/client';
import { FindBar, HighlightTextarea, findMatches } from './FindInText';
import { DiffView } from './DiffView';
import { RestartDependents } from './RestartDependents';

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

const VALUE_TYPOGRAPHY = 'p-2.5 font-mono text-xs leading-relaxed';

function entriesFrom(configMap: ConfigMapItem): ConfigKeyEntry[] {
  return Object.entries(configMap.data || {}).map(([k, val], idx) => ({
    id: `key-${idx}-${k}`,
    originalKey: k,
    key: k,
    value: val || '',
    originalValue: val || '',
  }));
}

// Mounted only while open so every open starts from fresh state (and hooks always run)
export const ConfigMapDetailModal: React.FC<ConfigMapDetailModalProps> = (props) =>
  props.isOpen && props.configMap ? <ConfigMapDetailModalBody {...props} configMap={props.configMap} /> : null;

const ConfigMapDetailModalBody: React.FC<ConfigMapDetailModalProps & { configMap: ConfigMapItem }> = ({
  configMap,
  context,
  onClose,
  onRefreshList,
  onOpenManifest,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<'data' | 'metadata'>('data');
  const [entries, setEntries] = useState<ConfigKeyEntry[]>(() => entriesFrom(configMap));
  const [searchKey, setSearchKey] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 'edit' -> 'review' (diff before applying) -> 'saved' (offer to restart dependents)
  const [phase, setPhase] = useState<'edit' | 'review' | 'saved'>('edit');
  const namespace = configMap.metadata.namespace || 'default';

  // Re-sync when the list refreshes underneath us, but never discard unsaved edits
  useEffect(() => {
    setEntries((prev) => (prev.some((e) => e.isNew || e.key !== e.originalKey || e.value !== e.originalValue) ? prev : entriesFrom(configMap)));
  }, [configMap]);

  const hasChanges = useMemo(() => {
    const originalKeys = Object.keys(configMap.data || {});
    if (entries.length !== originalKeys.length) return true;
    return entries.some((e) => e.isNew || e.key !== e.originalKey || e.value !== e.originalValue);
  }, [entries, configMap]);

  const filteredEntries = useMemo(() => {
    if (!searchKey.trim()) return entries;
    const q = caseSensitive ? searchKey : searchKey.toLowerCase();
    const norm = (s: string) => (caseSensitive ? s : s.toLowerCase());
    return entries.filter((e) => norm(e.key).includes(q) || norm(e.value).includes(q));
  }, [entries, searchKey, caseSensitive]);

  // Matches inside values, in display order; the active one is located by entry + local index
  const matchCounts = useMemo(
    () => filteredEntries.map((e) => findMatches(e.value, searchKey, { caseSensitive }).length),
    [filteredEntries, searchKey, caseSensitive]
  );
  const totalMatches = matchCounts.reduce((a, b) => a + b, 0);
  const activeLocation = useMemo(() => {
    let rest = activeMatch;
    for (let i = 0; i < matchCounts.length; i++) {
      if (rest < matchCounts[i]) return { entryIdx: i, local: rest };
      rest -= matchCounts[i];
    }
    return null;
  }, [activeMatch, matchCounts]);

  useEffect(() => setActiveMatch(0), [searchKey, caseSensitive]);
  useEffect(() => {
    if (activeMatch >= totalMatches && totalMatches > 0) setActiveMatch(totalMatches - 1);
  }, [totalMatches, activeMatch]);

  const navigateMatch = (dir: 1 | -1) => {
    if (totalMatches === 0) return;
    setActiveMatch((i) => (i + dir + totalMatches) % totalMatches);
  };

  // Ctrl+F jumps to the find box; Esc closes the modal (or leaves the review step)
  const findInputId = `cm-find-${configMap.metadata.uid || configMap.metadata.name}`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setActiveTab('data');
        setPhase('edit');
        requestAnimationFrame(() => (document.getElementById(findInputId)?.querySelector('input') as HTMLInputElement | null)?.select());
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (phase === 'review') setPhase('edit');
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findInputId, phase, onClose]);

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
    setEntries(entriesFrom(configMap));
    setSaveError(null);
    setPhase('edit');
  };

  // Validate, then show the diff before anything is applied
  const handleReview = () => {
    const keysSeen = new Set<string>();
    for (const e of entries) {
      const k = e.key.trim();
      if (!k) { setSaveError('Key names cannot be blank'); return; }
      if (keysSeen.has(k)) { setSaveError(`Duplicate key detected: "${k}"`); return; }
      keysSeen.add(k);
    }
    setSaveError(null);
    setPhase('review');
  };

  // Key-level change summary for the review step
  const changes = useMemo(() => {
    const original = configMap.data || {};
    const next: Record<string, string> = {};
    entries.forEach((e) => { next[e.key.trim()] = e.value; });
    const keys = Array.from(new Set([...Object.keys(original), ...Object.keys(next)])).sort();
    return keys
      .map((k) => ({
        key: k,
        before: original[k],
        after: next[k],
      }))
      .filter((c) => c.before !== c.after);
  }, [entries, configMap]);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setSaveError(null);

      const dataObj: Record<string, string> = {};
      for (const e of entries) {
        dataObj[e.key.trim()] = e.value;
      }

      const manifestObj = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: configMap.metadata.name,
          namespace,
          labels: configMap.metadata.labels,
          annotations: configMap.metadata.annotations,
        },
        data: dataObj,
      };

      await applyManifest(JSON.stringify(manifestObj, null, 2), context);

      // The applied values are the new baseline
      setEntries((prev) => prev.map((e) => ({ ...e, originalKey: e.key.trim(), key: e.key.trim(), originalValue: e.value, isNew: false })));
      setPhase('saved');
      onToast?.(`ConfigMap "${configMap.metadata.name}" saved successfully`);
      onRefreshList?.();
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save ConfigMap');
      onToast?.(err.message, 'error');
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
                  {namespace}
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
                onClick={() => onOpenManifest('configmaps', configMap.metadata.name, namespace)}
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
        {phase === 'edit' && (
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
              <div className="flex items-center gap-2 flex-1 max-w-md ml-auto">
                <div id={findInputId} className="flex-1 min-w-0">
                  <FindBar
                    query={searchKey}
                    onQueryChange={setSearchKey}
                    total={totalMatches}
                    active={activeMatch}
                    onNavigate={navigateMatch}
                    caseSensitive={caseSensitive}
                    onToggleCase={() => setCaseSensitive((c) => !c)}
                    placeholder="Find in keys & values… (Ctrl+F)"
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
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {phase === 'review' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-300">
                Review <span className="font-semibold text-amber-300">{changes.length} change(s)</span> before applying to{' '}
                <span className="font-mono text-slate-100">{namespace}/{configMap.metadata.name}</span>
                {context ? <> on <span className="font-mono text-cyan-300">{context}</span></> : null}:
              </div>
              {changes.map((c) => (
                <div key={c.key} className="border border-slate-800 rounded-lg p-3 bg-slate-950/60 space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-cyan-300">{c.key}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                      c.before === undefined ? 'text-emerald-300 border-emerald-800 bg-emerald-950/60'
                        : c.after === undefined ? 'text-rose-300 border-rose-800 bg-rose-950/60'
                        : 'text-amber-300 border-amber-800 bg-amber-950/60'
                    }`}>
                      {c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'modified'}
                    </span>
                  </div>
                  <DiffView before={c.before ?? ''} after={c.after ?? ''} className="max-h-72" />
                </div>
              ))}
            </div>
          )}

          {phase === 'saved' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4" /> Saved {configMap.metadata.name}.
              </div>
              <div className="border border-slate-800 rounded-lg p-4 bg-slate-950/60">
                <RestartDependents
                  refKind="configmap"
                  refName={configMap.metadata.name}
                  namespace={namespace}
                  context={context}
                  onToast={onToast}
                  onDone={onRefreshList}
                />
              </div>
            </div>
          )}

          {phase === 'edit' && activeTab === 'data' && (
            <>
              {filteredEntries.length === 0 ? (
                <div className="py-12 text-center text-slate-500 italic text-xs">
                  {searchKey ? 'No keys matching query.' : 'This ConfigMap contains no data keys.'}
                </div>
              ) : (
                filteredEntries.map((entry, entryIdx) => {
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
                          {searchKey && matchCounts[entryIdx] > 0 && (
                            <span className="text-[10px] text-cyan-400 font-mono shrink-0">
                              {matchCounts[entryIdx]} match{matchCounts[entryIdx] > 1 ? 'es' : ''}
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

                      {/* Multiline Value Editor with in-place search highlights */}
                      <div className="bg-slate-900/90 rounded-md">
                        <HighlightTextarea
                          value={entry.value}
                          onChange={(v) => handleValueChange(entry.id, v)}
                          query={searchKey}
                          findOptions={{ caseSensitive }}
                          activeMatch={activeLocation?.entryIdx === entryIdx ? activeLocation.local : -1}
                          rows={Math.min(14, Math.max(3, entry.value.split('\n').length))}
                          typography={VALUE_TYPOGRAPHY}
                          bordered
                          className="border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-cyan-500 resize-y"
                          placeholder="Configuration value..."
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}

          {phase === 'edit' && activeTab === 'metadata' && (
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
            {saveError && (
              <span className="text-rose-400 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{saveError}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {phase === 'edit' && hasChanges && (
              <button
                onClick={handleReset}
                disabled={isSaving}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
            {phase === 'edit' && (
              <button
                onClick={handleReview}
                disabled={!hasChanges}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:hover:bg-cyan-600 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Review & Save</span>
              </button>
            )}
            {phase === 'review' && (
              <>
                <button
                  onClick={() => setPhase('edit')}
                  disabled={isSaving}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to editing</span>
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving || changes.length === 0}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{isSaving ? 'Saving...' : 'Apply ConfigMap'}</span>
                </button>
              </>
            )}
            {phase === 'saved' && (
              <>
                <button
                  onClick={() => setPhase('edit')}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Keep editing
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 font-semibold text-xs transition-colors cursor-pointer"
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

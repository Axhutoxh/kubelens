import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  X, 
  ShieldCheck, 
  Lock, 
  Unlock, 
  Eye, 
  EyeOff, 
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
import { SecretItem } from '../types/k8s';
import { applyManifest } from '../api/client';
import { RestartDependents } from './RestartDependents';

export function decodeBase64(b64: string): string {
  if (!b64) return '';
  try {
    const clean = b64.replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    try {
      return atob(b64);
    } catch {
      return b64;
    }
  }
}

export function encodeBase64(text: string): string {
  if (!text) return '';
  try {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch {
    return btoa(text);
  }
}

interface SecretKeyEntry {
  id: string;
  originalKey: string;
  key: string;
  plainText: string;
  base64: string;
  isNew?: boolean;
  rowMode?: 'decrypted' | 'encrypted';
  isMasked?: boolean;
}

interface SecretDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  secret: SecretItem | null;
  currentContext?: string;
  onSaveSuccess?: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export const SecretDetailModal: React.FC<SecretDetailModalProps> = ({
  isOpen,
  onClose,
  secret,
  currentContext,
  onSaveSuccess,
  onToast,
}) => {
  // Global Decrypt/Encrypt mode: 'decrypted' (Plain Text) or 'encrypted' (Base64)
  const [globalMode, setGlobalMode] = useState<'decrypted' | 'encrypted'>('decrypted');
  // Global Masking (Eye / EyeOff)
  const [globalMasked, setGlobalMasked] = useState<boolean>(false);
  // Key entries list
  const [entries, setEntries] = useState<SecretKeyEntry[]>([]);
  // Search query within keys
  const [keySearch, setKeySearch] = useState('');
  // UI states
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Initialize entries when secret changes
  useEffect(() => {
    if (secret) {
      const rawData = secret.data || {};
      const initialEntries: SecretKeyEntry[] = Object.entries(rawData).map(([k, b64Val]) => {
        const decoded = decodeBase64(b64Val);
        return {
          id: `entry-${k}`,
          originalKey: k,
          key: k,
          plainText: decoded,
          base64: b64Val,
          isNew: false,
          rowMode: undefined, // defaults to globalMode
          isMasked: false,
        };
      });
      setEntries(initialEntries);
      setGlobalMode('decrypted');
      setGlobalMasked(false);
      setSaveError(null);
      setKeySearch('');
    }
  }, [secret]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Calculate dirty changes
  const hasChanges = useMemo(() => {
    if (!secret) return false;
    const origData = secret.data || {};
    const currentKeys = entries.map((e) => e.key.trim()).filter(Boolean);
    const origKeys = Object.keys(origData);

    if (currentKeys.length !== origKeys.length) return true;

    for (const entry of entries) {
      if (entry.isNew) return true;
      if (!entry.key.trim()) continue;
      if (entry.key !== entry.originalKey) return true;
      const origB64 = origData[entry.originalKey];
      if (entry.base64 !== origB64) return true;
    }
    return false;
  }, [secret, entries]);

  // Copy helper
  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  // Toggle Global Mode
  const handleToggleGlobalMode = (mode: 'decrypted' | 'encrypted') => {
    setGlobalMode(mode);
    // Reset individual row mode overrides
    setEntries((prev) => prev.map((e) => ({ ...e, rowMode: undefined })));
  };

  // Toggle Individual Row Mode
  const handleToggleRowMode = (id: string) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        const currentEffectiveMode = e.rowMode || globalMode;
        const nextMode = currentEffectiveMode === 'decrypted' ? 'encrypted' : 'decrypted';
        return { ...e, rowMode: nextMode };
      })
    );
  };

  // Toggle Individual Row Masking
  const handleToggleRowMask = (id: string) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        const effectiveMasked = e.isMasked !== undefined ? e.isMasked : globalMasked;
        return { ...e, isMasked: !effectiveMasked };
      })
    );
  };

  // Toggle Global Masking
  const handleToggleGlobalMask = () => {
    const nextMask = !globalMasked;
    setGlobalMasked(nextMask);
    setEntries((prev) => prev.map((e) => ({ ...e, isMasked: undefined })));
  };

  // Update Key Name
  const handleKeyNameChange = (id: string, newName: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, key: newName } : e))
    );
  };

  // Update Value
  const handleValueChange = (id: string, newValue: string, activeMode: 'decrypted' | 'encrypted') => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        if (activeMode === 'decrypted') {
          // Editing plain text: encode to Base64
          return {
            ...e,
            plainText: newValue,
            base64: encodeBase64(newValue),
          };
        } else {
          // Editing Base64: decode to plain text
          return {
            ...e,
            base64: newValue,
            plainText: decodeBase64(newValue),
          };
        }
      })
    );
  };

  // Add new Key Entry
  const handleAddKey = () => {
    const newId = `new-key-${Date.now()}`;
    const newEntry: SecretKeyEntry = {
      id: newId,
      originalKey: '',
      key: `NEW_KEY_${entries.length + 1}`,
      plainText: '',
      base64: '',
      isNew: true,
      rowMode: globalMode,
      isMasked: false,
    };
    setEntries((prev) => [...prev, newEntry]);
  };

  // Remove Key Entry
  const handleDeleteKey = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  // Discard all modifications
  const handleDiscard = () => {
    if (!secret) return;
    const rawData = secret.data || {};
    const initialEntries: SecretKeyEntry[] = Object.entries(rawData).map(([k, b64Val]) => ({
      id: `entry-${k}`,
      originalKey: k,
      key: k,
      plainText: decodeBase64(b64Val),
      base64: b64Val,
      isNew: false,
      rowMode: undefined,
      isMasked: false,
    }));
    setEntries(initialEntries);
    setGlobalMode('decrypted');
    setGlobalMasked(false);
    setSaveError(null);
  };

  // After a save: offer to restart the workloads that read this secret
  const [justSaved, setJustSaved] = useState(false);

  // Save & Apply Secret to Kubernetes
  const handleSaveSecret = async () => {
    if (!secret) return;
    setIsSaving(true);
    setSaveError(null);

    try {
      // Validate key names
      const dataMap: Record<string, string> = {};
      const keySet = new Set<string>();

      for (const entry of entries) {
        const k = entry.key.trim();
        if (!k) {
          throw new Error('Key name cannot be empty.');
        }
        if (keySet.has(k)) {
          throw new Error(`Duplicate key detected: "${k}". Keys must be unique.`);
        }
        keySet.add(k);
        dataMap[k] = entry.base64 || '';
      }

      // Construct Kubernetes Secret Manifest
      const secretManifest = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secret.metadata.name,
          namespace: secret.metadata.namespace,
          labels: secret.metadata.labels || {},
          annotations: secret.metadata.annotations || {},
        },
        type: secret.type || 'Opaque',
        data: dataMap,
      };

      const manifestYamlOrJson = JSON.stringify(secretManifest, null, 2);
      await applyManifest(manifestYamlOrJson, currentContext);

      onToast?.(`Secret "${secret.metadata.name}" saved and applied successfully!`, 'success');
      onSaveSuccess?.();
      setJustSaved(true);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save secret');
      onToast?.(err.message || 'Failed to save secret', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !secret) return null;

  // Filter entries
  const filteredEntries = entries.filter((e) => {
    if (!keySearch.trim()) return true;
    const q = keySearch.toLowerCase();
    return e.key.toLowerCase().includes(q) || e.plainText.toLowerCase().includes(q);
  });

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-3 md:p-6 select-text transition-all animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div 
        className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Bar */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/70 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-950/60 border border-amber-800/80 text-amber-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100 font-mono tracking-tight">
                  {secret.metadata.name}
                </h2>
                <span className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px] font-mono border border-slate-700">
                  {secret.metadata.namespace || 'default'}
                </span>
                <span className="bg-amber-950/80 text-amber-300 px-2 py-0.5 rounded text-[11px] font-mono border border-amber-800/70">
                  {secret.type || 'Opaque'}
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                <span>Created: {secret.metadata.creationTimestamp ? new Date(secret.metadata.creationTimestamp).toLocaleString() : 'N/A'}</span>
                <span>•</span>
                <span className="text-cyan-400 font-medium">{entries.length} keys total</span>
                {hasChanges && (
                  <>
                    <span>•</span>
                    <span className="text-amber-400 font-medium flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                      Unsaved changes
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global Action Toolbar */}
        <div className="px-6 py-3 border-b border-slate-800/90 bg-slate-900/90 flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Decrypt / Encrypt Master Switch */}
          <div className="flex items-center gap-2 bg-slate-950 p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => handleToggleGlobalMode('decrypted')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all ${
                globalMode === 'decrypted'
                  ? 'bg-emerald-600 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show values as plain text decoded from Base64"
            >
              <Unlock className="w-3.5 h-3.5" />
              <span>Decrypted (Plain Text)</span>
            </button>

            <button
              onClick={() => handleToggleGlobalMode('encrypted')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all ${
                globalMode === 'encrypted'
                  ? 'bg-amber-600 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show raw Base64 encoded values stored in Kubernetes"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Encrypted (Base64)</span>
            </button>
          </div>

          {/* Visibility & Search Controls */}
          <div className="flex items-center gap-2.5 flex-1 max-w-md justify-end">
            {/* Search Input */}
            <div className="relative flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
              <input
                type="text"
                placeholder="Search keys or values..."
                value={keySearch}
                onChange={(e) => setKeySearch(e.target.value)}
                className="w-full bg-slate-950/80 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
              />
              {keySearch && (
                <button
                  onClick={() => setKeySearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Global Mask / Unmask */}
            <button
              onClick={handleToggleGlobalMask}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                globalMasked
                  ? 'bg-slate-800 border-slate-700 text-slate-300'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title={globalMasked ? 'Reveal values' : 'Mask values with asterisks'}
            >
              {globalMasked ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5 text-cyan-400" />}
              <span>{globalMasked ? 'Masked' : 'Revealed'}</span>
            </button>

            {/* Add Key Button */}
            <button
              onClick={handleAddKey}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-950/80 hover:bg-cyan-900/90 text-cyan-300 border border-cyan-800/80 text-xs font-medium transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Key</span>
            </button>
          </div>
        </div>

        {/* Error Banner if save failed */}
        {saveError && (
          <div className="mx-6 mt-3 p-3 rounded-lg bg-rose-950/70 border border-rose-800 text-rose-300 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{saveError}</span>
            </div>
            <button onClick={() => setSaveError(null)} className="text-rose-400 hover:text-rose-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Secret Key/Values List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {filteredEntries.length === 0 ? (
            <div className="text-center py-12 text-slate-500 border border-dashed border-slate-800 rounded-xl">
              <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-slate-600" />
              <p className="text-sm font-medium">No secret keys {keySearch ? 'matched the filter' : 'found'}</p>
              {keySearch ? (
                <button
                  onClick={() => setKeySearch('')}
                  className="mt-2 text-xs text-cyan-400 hover:underline"
                >
                  Clear search filter
                </button>
              ) : (
                <button
                  onClick={handleAddKey}
                  className="mt-3 px-3 py-1.5 rounded-lg bg-cyan-950 text-cyan-300 border border-cyan-800 text-xs font-medium hover:bg-cyan-900 transition-all inline-flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add First Key</span>
                </button>
              )}
            </div>
          ) : (
            filteredEntries.map((entry) => {
              const effectiveMode = entry.rowMode || globalMode;
              const isDecrypted = effectiveMode === 'decrypted';
              const effectiveMasked = entry.isMasked !== undefined ? entry.isMasked : globalMasked;
              const displayValue = isDecrypted ? entry.plainText : entry.base64;
              const byteSize = entry.plainText ? new TextEncoder().encode(entry.plainText).length : 0;
              const isMultiline = displayValue.includes('\n') || displayValue.length > 90;

              // Check if modified
              const origData = secret.data || {};
              const isModified = entry.isNew || (origData[entry.originalKey] !== entry.base64);

              return (
                <div 
                  key={entry.id} 
                  className={`rounded-xl border transition-all ${
                    isModified 
                      ? 'bg-slate-950/60 border-amber-600/50 shadow-sm' 
                      : 'bg-slate-950/40 border-slate-800/90 hover:border-slate-700/80'
                  }`}
                >
                  {/* Entry Header */}
                  <div className="px-4 py-2.5 border-b border-slate-800/70 bg-slate-950/80 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {/* Key Name Input / Label */}
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Tag className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <input
                          type="text"
                          value={entry.key}
                          onChange={(e) => handleKeyNameChange(entry.id, e.target.value)}
                          placeholder="KEY_NAME"
                          className="bg-transparent font-mono font-bold text-xs text-slate-100 hover:bg-slate-800/50 focus:bg-slate-800 px-1.5 py-0.5 rounded border border-transparent focus:border-cyan-500 focus:outline-none transition-colors max-w-xs"
                        />
                      </div>

                      {/* Byte count badge */}
                      <span className="text-[10px] text-slate-500 font-mono">
                        {byteSize < 1024 ? `${byteSize} B` : `${(byteSize / 1024).toFixed(1)} KB`}
                      </span>

                      {/* Mode Badge */}
                      <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold border ${
                        isDecrypted 
                          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60' 
                          : 'bg-amber-950/80 text-amber-300 border-amber-800/60'
                      }`}>
                        {isDecrypted ? 'Plain Text' : 'Base64'}
                      </span>

                      {/* Edited indicator */}
                      {isModified && (
                        <span className="text-[10px] font-medium bg-amber-950 text-amber-400 border border-amber-800/80 px-1.5 py-0.2 rounded">
                          {entry.isNew ? 'New' : 'Edited'}
                        </span>
                      )}
                    </div>

                    {/* Entry Actions */}
                    <div className="flex items-center gap-1 select-none font-sans">
                      {/* Row Encrypt/Decrypt Switch */}
                      <button
                        onClick={() => handleToggleRowMode(entry.id)}
                        className={`p-1.5 rounded transition-colors ${
                          isDecrypted
                            ? 'text-emerald-400 hover:bg-emerald-950/60 hover:text-emerald-300'
                            : 'text-amber-400 hover:bg-amber-950/60 hover:text-amber-300'
                        }`}
                        title={isDecrypted ? 'Switch this key to Encrypted (Base64)' : 'Switch this key to Decrypted (Plain Text)'}
                      >
                        {isDecrypted ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                      </button>

                      {/* Row Mask/Reveal Toggle */}
                      <button
                        onClick={() => handleToggleRowMask(entry.id)}
                        className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
                        title={effectiveMasked ? 'Reveal value' : 'Mask value'}
                      >
                        {effectiveMasked ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>

                      {/* Copy Value */}
                      <button
                        onClick={() => handleCopy(entry.id, displayValue)}
                        className="p-1.5 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
                        title={`Copy ${isDecrypted ? 'Decrypted' : 'Encrypted'} Value`}
                      >
                        {copiedKey === entry.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {/* Delete Key */}
                      <button
                        onClick={() => handleDeleteKey(entry.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors ml-1"
                        title="Delete key"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Entry Value Field */}
                  <div className="p-3">
                    {effectiveMasked ? (
                      <div className="flex items-center justify-between py-2 px-3 bg-slate-900/90 rounded-lg border border-slate-800 font-mono text-xs text-slate-500">
                        <span className="tracking-widest select-none">
                          ••••••••••••••••••••••••••••••••
                        </span>
                        <button
                          onClick={() => handleToggleRowMask(entry.id)}
                          className="text-xs text-cyan-400 hover:underline flex items-center gap-1 font-sans"
                        >
                          <Eye className="w-3 h-3" />
                          <span>Reveal</span>
                        </button>
                      </div>
                    ) : isMultiline ? (
                      <div className="relative">
                        <textarea
                          rows={Math.min(displayValue.split('\n').length + 1, 10)}
                          value={displayValue}
                          onChange={(e) => handleValueChange(entry.id, e.target.value, effectiveMode)}
                          placeholder="Value..."
                          className="w-full bg-slate-900/90 border border-slate-800/80 rounded-lg p-3 font-mono text-xs text-cyan-200 leading-relaxed focus:border-cyan-500 focus:bg-slate-900 focus:outline-none transition-colors resize-y"
                          spellCheck={false}
                        />
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={displayValue}
                        onChange={(e) => handleValueChange(entry.id, e.target.value, effectiveMode)}
                        placeholder="Value..."
                        className="w-full bg-slate-900/90 border border-slate-800/80 rounded-lg px-3 py-2 font-mono text-xs text-cyan-200 focus:border-cyan-500 focus:bg-slate-900 focus:outline-none transition-colors"
                        spellCheck={false}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Modal Footer / Save & Discard Controls */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/90 flex items-center justify-between">
          <div className="text-xs text-slate-400 flex items-center gap-2">
            {hasChanges ? (
              <span className="text-amber-400 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                Unsaved modifications present. Click "Save & Apply" to update cluster secret.
              </span>
            ) : (
              <span className="text-slate-500 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                All values match cluster secret.
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            {hasChanges && (
              <button
                type="button"
                onClick={handleDiscard}
                disabled={isSaving}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/70 hover:bg-slate-800 text-slate-300 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Discard</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-medium transition-colors disabled:opacity-50"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleSaveSecret}
              disabled={isSaving || !hasChanges}
              className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-xs font-semibold shadow-lg shadow-cyan-950/50 flex items-center gap-1.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving & Applying...</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save & Apply Secret</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {justSaved && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-6">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-5 space-y-4">
            <div className="text-sm font-semibold text-emerald-300">Saved {secret.metadata.name}</div>
            <RestartDependents
              refKind="secret"
              refName={secret.metadata.name}
              namespace={secret.metadata.namespace || 'default'}
              context={currentContext}
              onToast={onToast}
            />
            <div className="flex justify-end">
              <button
                onClick={() => { setJustSaved(false); onClose(); }}
                className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 font-semibold text-xs"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

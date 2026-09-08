import React, { useState } from 'react';
import { X, Sliders, CheckCircle, AlertCircle } from 'lucide-react';
import { scaleResource } from '../api/client';

interface ScaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  target: {
    kind: string;
    name: string;
    namespace: string;
    currentReplicas: number;
  } | null;
}

export const ScaleModal: React.FC<ScaleModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  target,
}) => {
  const [replicas, setReplicas] = useState(target?.currentReplicas ?? 1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (target) {
      setReplicas(target.currentReplicas);
      setError(null);
    }
  }, [target]);

  if (!isOpen || !target) return null;

  const handleScale = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await scaleResource(target.kind, target.name, target.namespace, replicas);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">Scale {target.kind}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 p-1 rounded-md">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          <div>
            <div className="text-xs text-slate-400">Target Resource:</div>
            <div className="text-sm font-medium text-slate-200 mt-0.5">
              {target.namespace}/{target.name}
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded-md bg-rose-950/80 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Desired Replicas:</span>
              <span className="text-cyan-400 font-mono font-bold text-sm">{replicas}</span>
            </div>
            <input
              type="range"
              min="0"
              max="20"
              value={replicas}
              onChange={(e) => setReplicas(parseInt(e.target.value, 10))}
              className="w-full accent-cyan-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-slate-500 font-mono">
              <span>0 (Stop)</span>
              <span>5</span>
              <span>10</span>
              <span>15</span>
              <span>20</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleScale}
            disabled={isSubmitting}
            className="bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold px-4 py-1.5 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isSubmitting ? 'Scaling...' : 'Apply Scale'}
          </button>
        </div>
      </div>
    </div>
  );
};

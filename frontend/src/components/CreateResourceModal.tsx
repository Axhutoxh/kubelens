import React, { useState } from 'react';
import { X, Play, CheckCircle, AlertCircle } from 'lucide-react';
import { applyManifest } from '../api/client';

interface CreateResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  defaultNamespace?: string;
}

const TEMPLATES: Record<string, string> = {
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  namespace: default
  labels:
    app: demo-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      containers:
      - name: web
        image: nginx:alpine
        ports:
        - containerPort: 80
        resources:
          limits:
            cpu: "250m"
            memory: "256Mi"
          requests:
            cpu: "100m"
            memory: "128Mi"
`,
  Service: `apiVersion: v1
kind: Service
metadata:
  name: demo-service
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: demo-app
  ports:
  - port: 80
    targetPort: 80
    protocol: TCP
`,
  Pod: `apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: default
  labels:
    app: test
spec:
  containers:
  - name: alpine
    image: alpine:latest
    command: ["sh", "-c", "echo Running && sleep 3600"]
`,
  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: default
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
`,
  Namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: new-environment
`,
};

export const CreateResourceModal: React.FC<CreateResourceModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [selectedTemplate, setSelectedTemplate] = useState('Deployment');
  const [manifest, setManifest] = useState(TEMPLATES.Deployment);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<{ success?: boolean; message?: string } | null>(null);

  if (!isOpen) return null;

  const handleTemplateChange = (templateName: string) => {
    setSelectedTemplate(templateName);
    setManifest(TEMPLATES[templateName] || '');
    setStatus(null);
  };

  const handleCreate = async () => {
    if (!manifest.trim()) return;
    setIsSubmitting(true);
    setStatus(null);
    try {
      const res = await applyManifest(manifest);
      setStatus({ success: true, message: res.output || 'Resource created successfully' });
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      setStatus({ success: false, message: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Create Kubernetes Resource</h3>
            <p className="text-xs text-slate-400">Deploy resources to your active cluster using raw YAML</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 p-1 rounded-md">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Template Selector Bar */}
        <div className="px-4 py-2.5 bg-slate-950/60 border-b border-slate-800 flex items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">Templates:</span>
          {Object.keys(TEMPLATES).map((t) => (
            <button
              key={t}
              onClick={() => handleTemplateChange(t)}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                selectedTemplate === t
                  ? 'bg-cyan-600 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Editor Body */}
        <div className="flex-1 p-4 flex flex-col min-h-[300px]">
          {status && (
            <div className={`mb-3 p-2.5 rounded-md text-xs flex items-center gap-2 ${
              status.success ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300' : 'bg-rose-950/80 border border-rose-800 text-rose-300'
            }`}>
              {status.success ? <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />}
              <span>{status.message}</span>
            </div>
          )}

          <textarea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            className="flex-1 w-full bg-slate-950 text-cyan-200 border border-slate-800 rounded-lg p-3 font-mono text-xs focus:outline-none focus:border-cyan-500/80 resize-none selection:bg-cyan-600/30"
            spellCheck={false}
          />
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
            onClick={handleCreate}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold px-4 py-1.5 rounded-md transition-colors shadow-sm disabled:opacity-50 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isSubmitting ? 'Deploying...' : 'Deploy to Cluster'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

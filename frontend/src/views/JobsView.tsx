import React, { useState } from 'react';
import { 
  Activity, 
  Calendar, 
  Play, 
  Pause, 
  FileCode, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  Clock,
  RotateCcw
} from 'lucide-react';
import { JobItem, CronJobItem } from '../types/k8s';

interface JobsViewProps {
  jobs: JobItem[];
  cronJobs: CronJobItem[];
  searchQuery: string;
  onOpenManifest: (kind: string, name: string, namespace: string) => void;
  onDelete: (kind: string, name: string, namespace: string) => void;
  onTriggerCronJob?: (cronJob: CronJobItem) => void;
  onToggleSuspendCronJob?: (cronJob: CronJobItem) => void;
}

export const JobsView: React.FC<JobsViewProps> = ({
  jobs,
  cronJobs,
  searchQuery,
  onOpenManifest,
  onDelete,
  onTriggerCronJob,
  onToggleSuspendCronJob,
}) => {
  const [activeTab, setActiveTab] = useState<'jobs' | 'cronjobs'>('jobs');

  const filteredJobs = jobs.filter((j) => {
    const name = j.metadata.name.toLowerCase();
    const ns = (j.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q);
  });

  const filteredCronJobs = cronJobs.filter((cj) => {
    const name = cj.metadata.name.toLowerCase();
    const ns = (cj.metadata.namespace || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return name.includes(q) || ns.includes(q);
  });

  const calculateDuration = (startTime?: string, completionTime?: string) => {
    if (!startTime) return '-';
    const start = new Date(startTime).getTime();
    const end = completionTime ? new Date(completionTime).getTime() : Date.now();
    const diffSec = Math.max(0, Math.floor((end - start) / 1000));
    if (diffSec < 60) return `${diffSec}s`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`;
    return `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m`;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header & Tabs */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-medium">
            <Activity className="w-4 h-4 text-cyan-400" />
            <span className="text-slate-200">Batch Workloads</span>
          </div>

          <div className="flex bg-slate-950 p-0.5 rounded-lg border border-slate-800">
            <button
              onClick={() => setActiveTab('jobs')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'jobs'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Jobs</span>
              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
                {jobs.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('cronjobs')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'cronjobs'
                  ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>CronJobs</span>
              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.2 rounded text-[10px] font-mono">
                {cronJobs.length}
              </span>
            </button>
          </div>
        </div>

        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          {activeTab === 'jobs' 
            ? 'One-off batch tasks running to completion' 
            : 'Scheduled recurring automated cluster tasks'}
        </span>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'jobs' ? (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                <th className="py-2.5 px-4 font-semibold">Namespace</th>
                <th className="py-2.5 px-4 font-semibold">Completions</th>
                <th className="py-2.5 px-4 font-semibold">Status</th>
                <th className="py-2.5 px-4 font-semibold">Duration</th>
                <th className="py-2.5 px-4 font-semibold">Age</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500 italic">
                    No Jobs found.
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job) => {
                  const succeeded = job.status?.succeeded ?? 0;
                  const target = job.spec?.completions ?? 1;
                  const isDone = succeeded >= target;
                  const isFailed = (job.status?.failed ?? 0) > 0;
                  const isActive = (job.status?.active ?? 0) > 0;
                  const duration = calculateDuration(job.status?.startTime, job.status?.completionTime);
                  const age = job.metadata.creationTimestamp 
                    ? new Date(job.metadata.creationTimestamp).toLocaleDateString()
                    : 'N/A';

                  return (
                    <tr key={job.metadata.uid || job.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                        <Activity className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span className="truncate max-w-xs">{job.metadata.name}</span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-400">
                        <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                          {job.metadata.namespace}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-200">
                        {succeeded} / {target}
                      </td>
                      <td className="py-2.5 px-4">
                        {isDone ? (
                          <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Complete
                          </span>
                        ) : isFailed ? (
                          <span className="bg-rose-950 text-rose-400 border border-rose-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max">
                            <AlertCircle className="w-2.5 h-2.5" /> Failed
                          </span>
                        ) : isActive ? (
                          <span className="bg-blue-950 text-blue-400 border border-blue-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max">
                            <Clock className="w-2.5 h-2.5 animate-spin" /> Running
                          </span>
                        ) : (
                          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[10px]">
                            Pending
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-slate-400">{duration}</td>
                      <td className="py-2.5 px-4 text-slate-400">{age}</td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1 font-sans">
                          <button
                            onClick={() => onOpenManifest('jobs', job.metadata.name, job.metadata.namespace || 'default')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="View YAML Manifest"
                          >
                            <FileCode className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete('job', job.metadata.name, job.metadata.namespace || 'default')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete Job"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
              <tr>
                <th className="py-2.5 px-4 font-semibold">Name</th>
                <th className="py-2.5 px-4 font-semibold">Namespace</th>
                <th className="py-2.5 px-4 font-semibold">Schedule</th>
                <th className="py-2.5 px-4 font-semibold">Suspend</th>
                <th className="py-2.5 px-4 font-semibold">Active Jobs</th>
                <th className="py-2.5 px-4 font-semibold">Last Schedule</th>
                <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
              {filteredCronJobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500 italic">
                    No CronJobs found.
                  </td>
                </tr>
              ) : (
                filteredCronJobs.map((cj) => {
                  const isSuspended = cj.spec?.suspend === true;
                  const activeCount = cj.status?.active?.length ?? 0;
                  const lastSchedule = cj.status?.lastScheduleTime 
                    ? new Date(cj.status.lastScheduleTime).toLocaleString()
                    : 'Never';

                  return (
                    <tr key={cj.metadata.uid || cj.metadata.name} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4 font-medium text-slate-100 flex items-center gap-2">
                        <Calendar className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        <span className="truncate max-w-xs">{cj.metadata.name}</span>
                      </td>
                      <td className="py-2.5 px-4 text-slate-400">
                        <span className="bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                          {cj.metadata.namespace}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="bg-slate-900 border border-slate-700/60 text-cyan-300 px-2 py-0.5 rounded text-[11px] font-mono">
                          {cj.spec?.schedule || '* * * * *'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        {isSuspended ? (
                          <span className="bg-amber-950 text-amber-400 border border-amber-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max">
                            <Pause className="w-2.5 h-2.5" /> Suspended
                          </span>
                        ) : (
                          <span className="bg-emerald-950 text-emerald-400 border border-emerald-800/80 px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max">
                            <Play className="w-2.5 h-2.5" /> Active
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-slate-300">{activeCount}</td>
                      <td className="py-2.5 px-4 text-slate-400">{lastSchedule}</td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1 font-sans">
                          {onTriggerCronJob && (
                            <button
                              onClick={() => onTriggerCronJob(cj)}
                              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-300 transition-colors cursor-pointer"
                              title="Trigger Job Now (kubectl create job --from=cronjob/...)"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => onOpenManifest('cronjobs', cj.metadata.name, cj.metadata.namespace || 'default')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                            title="View YAML Manifest"
                          >
                            <FileCode className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete('cronjob', cj.metadata.name, cj.metadata.namespace || 'default')}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                            title="Delete CronJob"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

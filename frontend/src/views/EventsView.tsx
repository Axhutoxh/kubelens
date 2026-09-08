import React from 'react';
import { Radio, AlertTriangle, Info } from 'lucide-react';
import { EventItem } from '../types/k8s';

interface EventsViewProps {
  events: EventItem[];
  searchQuery: string;
}

export const EventsView: React.FC<EventsViewProps> = ({ events, searchQuery }) => {
  const filtered = events.filter((e) => {
    const reason = (e.reason || '').toLowerCase();
    const msg = (e.message || '').toLowerCase();
    const obj = (e.involvedObject?.name || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    return reason.includes(q) || msg.includes(q) || obj.includes(q);
  });

  return (
    <div className="h-full flex flex-col overflow-hidden select-text">
      {/* Header */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-xs text-slate-400 select-none">
        <div className="flex items-center gap-2 font-medium">
          <Radio className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-200">Cluster Events</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono text-[11px]">
            {filtered.length} of {events.length}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-950/80 text-slate-400 sticky top-0 z-10 border-b border-slate-800 select-none backdrop-blur-sm">
            <tr>
              <th className="py-2.5 px-4 font-semibold">Type</th>
              <th className="py-2.5 px-4 font-semibold">Reason</th>
              <th className="py-2.5 px-4 font-semibold">Involved Object</th>
              <th className="py-2.5 px-4 font-semibold">Message</th>
              <th className="py-2.5 px-4 font-semibold">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50 font-mono text-slate-300">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-500 italic">
                  No events found.
                </td>
              </tr>
            ) : (
              filtered.map((event, idx) => {
                const isWarning = event.type === 'Warning';
                const time = event.lastTimestamp 
                  ? new Date(event.lastTimestamp).toLocaleTimeString()
                  : 'N/A';

                return (
                  <tr key={idx} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-2.5 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 w-max ${
                        isWarning ? 'bg-amber-950 text-amber-400 border border-amber-800/80' : 'bg-slate-800 text-slate-300'
                      }`}>
                        {isWarning ? <AlertTriangle className="w-2.5 h-2.5" /> : <Info className="w-2.5 h-2.5" />}
                        {event.type}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-semibold text-slate-200">{event.reason}</td>
                    <td className="py-2.5 px-4 text-cyan-300 truncate max-w-xs">
                      {event.involvedObject?.kind} / {event.involvedObject?.name}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400 font-sans leading-relaxed max-w-md">
                      {event.message}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">{time}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

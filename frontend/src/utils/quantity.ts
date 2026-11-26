/** "250m" / "1" / "1.5" -> millicores (NaN when unparseable) */
export function cpuMillis(q?: string | number): number {
  if (q === undefined || q === null || q === '') return NaN;
  const s = String(q).trim();
  const m = /^([\d.]+)(n|u|m)?$/.exec(s);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return m[2] === 'n' ? n / 1e6 : m[2] === 'u' ? n / 1e3 : m[2] === 'm' ? n : n * 1000;
}

/** "512Mi" / "1Gi" / "1G" / bytes -> MiB (NaN when unparseable) */
export function memoryMi(q?: string | number): number {
  if (q === undefined || q === null || q === '') return NaN;
  const m = /^([\d.]+)([A-Za-z]*)$/.exec(String(q).trim());
  if (!m) return NaN;
  const units: Record<string, number> = { '': 1 / 1048576, Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, k: 1e3 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, T: 1e12 / 1048576 };
  const u = units[m[2]];
  return u === undefined ? NaN : parseFloat(m[1]) * u;
}

export const formatCpu = (m: number) => (!isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`);
export const formatMem = (mi: number) => (!isFinite(mi) ? '—' : mi >= 1024 ? `${(mi / 1024).toFixed(2)}Gi` : `${Math.round(mi)}Mi`);

/** Sum of a resource over a pod template's containers; NaN when any container doesn't set it. */
export function podTotal(containers: any[] | undefined, kind: 'requests' | 'limits', res: 'cpu' | 'memory'): number {
  const list = containers || [];
  if (list.length === 0) return NaN;
  let total = 0;
  for (const c of list) {
    const v = c?.resources?.[kind]?.[res];
    const n = res === 'cpu' ? cpuMillis(v) : memoryMi(v);
    if (!isFinite(n)) return NaN;
    total += n;
  }
  return total;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

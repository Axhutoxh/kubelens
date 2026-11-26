import { ForwardKind } from '../api/v18';

// Port forwards saved to restart with one click. Each belongs to the workspace that was active
// when it was saved (or to none, which shows everywhere). Kept in this browser profile only.

export interface SavedForward {
  id: string;
  workspaceId: string | null;
  context?: string;
  namespace: string;
  kind: ForwardKind;
  name: string;
  port: number;
  /** Fixed local port, so bookmarks and URLs stay the same */
  localPort?: number;
}

const KEY = 'kubellens_saved_forwards';

export function loadSavedForwards(): SavedForward[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function storeSavedForwards(list: SavedForward[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-100))); } catch { /* storage unavailable */ }
}

export const KIND_SHORT: Record<string, string> = { pod: 'pod', service: 'svc', deployment: 'deploy', statefulset: 'sts' };

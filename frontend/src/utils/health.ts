import { DeploymentItem } from '../types/k8s';

export interface HealthIssue {
  id: string;
  text: string;
  /** Points taken off the score */
  weight: number;
}

export interface HealthScore {
  score: number;
  grade: 'good' | 'fair' | 'poor';
  issues: HealthIssue[];
}

/** True for `image`, `image:latest` and `registry:5000/image` (no tag); digests are pinned. */
export function isUnpinnedTag(image = '') {
  if (image.includes('@')) return false;
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon <= lastSlash) return true;
  return image.slice(lastColon + 1) === 'latest';
}

/**
 * Best-practice checks on a deployment's pod template, as a 0-100 score. Each kind of problem
 * counts once however many containers have it; the issue text names the containers.
 */
export function deploymentHealth(dep: DeploymentItem): HealthScore {
  const spec: any = dep.spec?.template?.spec || {};
  const containers: any[] = spec.containers || [];
  const issues: HealthIssue[] = [];
  const add = (id: string, weight: number, names: string[], text: (list: string) => string) => {
    if (names.length) issues.push({ id, weight, text: text(names.join(', ')) });
  };
  const missing = (pred: (c: any) => boolean) => containers.filter(pred).map((c) => c.name);

  add('limits', 15, missing((c) => !c.resources?.limits?.memory || !c.resources?.limits?.cpu),
    (l) => `No CPU / memory limits (${l}): one pod can starve its node`);
  add('requests', 10, missing((c) => !c.resources?.requests?.memory || !c.resources?.requests?.cpu),
    (l) => `No CPU / memory requests (${l}): the scheduler can't place it well`);
  add('readiness', 15, missing((c) => !c.readinessProbe),
    (l) => `No readiness probe (${l}): traffic arrives before the app is ready`);
  add('liveness', 5, missing((c) => !c.livenessProbe && !c.startupProbe),
    (l) => `No liveness probe (${l}): a hung process is never restarted`);
  add('tag', 15, missing((c) => isUnpinnedTag(c.image)),
    (l) => `Image without a fixed tag or using :latest (${l}): rollouts aren't reproducible`);

  const desired = dep.spec?.replicas ?? 1;
  if (desired === 1) issues.push({ id: 'replicas', weight: 10, text: 'Single replica: any restart or node drain is an outage' });

  const podNonRoot = spec.securityContext?.runAsNonRoot === true || (spec.securityContext?.runAsUser ?? -1) > 0;
  add('privileged', 20, missing((c) => c.securityContext?.privileged === true),
    (l) => `Privileged container (${l}): full access to the node`);
  add('root', 5, missing((c) => !podNonRoot && c.securityContext?.runAsNonRoot !== true && !((c.securityContext?.runAsUser ?? -1) > 0)),
    (l) => `May run as root (${l}): set runAsNonRoot`);

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + i.weight, 0));
  return { score, grade: score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor', issues: issues.sort((a, b) => b.weight - a.weight) };
}

import { RbacGrant, RbacIndex, RbacRule, RbacSubject } from '../api/insights';

/** API group of common resources, so a rule for e.g. metrics.k8s.io "pods" isn't mistaken for core pods */
export const RESOURCE_GROUPS: Record<string, string> = {
  pods: '', 'pods/log': '', 'pods/exec': '', 'pods/portforward': '', 'pods/attach': '', 'pods/eviction': '',
  secrets: '', configmaps: '', services: '', serviceaccounts: '', 'serviceaccounts/token': '', nodes: '', namespaces: '',
  persistentvolumeclaims: '', persistentvolumes: '', events: '', endpoints: '',
  deployments: 'apps', 'deployments/scale': 'apps', statefulsets: 'apps', daemonsets: 'apps', replicasets: 'apps',
  jobs: 'batch', cronjobs: 'batch',
  ingresses: 'networking.k8s.io', networkpolicies: 'networking.k8s.io',
  roles: 'rbac.authorization.k8s.io', rolebindings: 'rbac.authorization.k8s.io',
  clusterroles: 'rbac.authorization.k8s.io', clusterrolebindings: 'rbac.authorization.k8s.io',
  horizontalpodautoscalers: 'autoscaling', poddisruptionbudgets: 'policy',
  customresourcedefinitions: 'apiextensions.k8s.io', storageclasses: 'storage.k8s.io',
};

export const CLUSTER_SCOPED = new Set(['nodes', 'namespaces', 'persistentvolumes', 'clusterroles', 'clusterrolebindings', 'customresourcedefinitions', 'storageclasses']);

export const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'bind', 'escalate', 'impersonate'];

// Kubernetes' own resource matching: "*", an exact name, or "*" + "/<subresource>" (e.g. "*" + "/scale")
function resourceMatches(ruleResource: string, requested: string) {
  if (ruleResource === '*' || ruleResource === requested) return true;
  const slash = requested.indexOf('/');
  return slash > 0 && ruleResource === `*/${requested.slice(slash + 1)}`;
}

export function ruleMatches(rule: RbacRule, verb: string, resource: string): boolean {
  if (rule.resources.length === 0) return false; // nonResourceURLs only
  if (!rule.verbs.includes('*') && !rule.verbs.includes(verb)) return false;
  const group = RESOURCE_GROUPS[resource];
  if (group !== undefined && !rule.apiGroups.includes('*') && !rule.apiGroups.includes(group)) return false;
  return rule.resources.some((r) => resourceMatches(r, resource));
}

/** Does this grant apply in `namespace` ("_any" = anywhere)? RoleBindings never cover cluster-scoped resources. */
export function grantCovers(g: RbacGrant, namespace: string, resource: string) {
  if (CLUSTER_SCOPED.has(resource)) return g.scope === '*';
  return g.scope === '*' || namespace === '_any' || g.scope === namespace;
}

export interface WhoCanHit {
  subject: RbacSubject;
  grant: RbacGrant;
  rule: RbacRule;
  /** Rule only covers specific object names */
  limited: boolean;
}

export function whoCan(index: RbacIndex, verb: string, resource: string, namespace: string): WhoCanHit[] {
  const hits: WhoCanHit[] = [];
  for (const subject of index.subjects) {
    for (const grant of subject.grants) {
      if (!grantCovers(grant, namespace, resource)) continue;
      const rule = (index.roles[grant.role] || []).find((r) => ruleMatches(r, verb, resource));
      if (rule) hits.push({ subject, grant, rule, limited: rule.resourceNames.length > 0 });
    }
  }
  return hits;
}

/** Notable powers worth flagging on a role */
export const NOTABLE: Array<{ label: string; verb: string; resource: string; tone: string }> = [
  { label: 'full access', verb: '*', resource: '*', tone: 'text-rose-300 border-rose-800/80 bg-rose-950/50' },
  { label: 'reads Secrets', verb: 'get', resource: 'secrets', tone: 'text-amber-300 border-amber-800/80 bg-amber-950/50' },
  { label: 'exec into pods', verb: 'create', resource: 'pods/exec', tone: 'text-amber-300 border-amber-800/80 bg-amber-950/50' },
  { label: 'binds roles', verb: 'bind', resource: 'clusterroles', tone: 'text-rose-300 border-rose-800/80 bg-rose-950/50' },
  { label: 'impersonates', verb: 'impersonate', resource: 'users', tone: 'text-rose-300 border-rose-800/80 bg-rose-950/50' },
];

export function notables(rules: RbacRule[]) {
  return NOTABLE.filter((n) =>
    n.verb === '*'
      ? rules.some((r) => r.verbs.includes('*') && r.resources.includes('*') && r.apiGroups.includes('*'))
      : rules.some((r) => ruleMatches(r, n.verb, n.resource) && r.resourceNames.length === 0)
  );
}

export const subjectKey = (s: RbacSubject) => `${s.kind}/${s.namespace || ''}/${s.name}`;
export const roleName = (key: string) => key.replace(/^ClusterRole\//, '').replace(/^Role\/[^/]+\//, '');

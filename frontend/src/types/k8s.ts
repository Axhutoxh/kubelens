export interface ContextItem {
  name: string;
  isActive: boolean;
}

export interface ClusterOverviewData {
  context: string;
  server: string;
  nodesCount: number;
  podsCount: number;
  namespacesCount: number;
}

export interface KubeMetadata {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{
    apiVersion?: string;
    kind: string;
    name: string;
    uid?: string;
    controller?: boolean;
  }>;
}

export interface PortForwardSession {
  id: string;
  pod: string;
  namespace: string;
  containerPort: number;
  localPort: number;
  url: string;
  status: string;
  startedAt: string;
}

export interface ContainerPort {
  containerPort: number;
  name?: string;
  protocol?: string;
}

export interface ContainerEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string; optional?: boolean };
    configMapKeyRef?: { name: string; key: string; optional?: boolean };
    fieldRef?: { fieldPath: string };
    resourceFieldRef?: { containerName?: string; resource: string; divisor?: string };
    [key: string]: any;
  };
}

export interface ContainerEnvFromSource {
  configMapRef?: { name: string };
  secretRef?: { name: string };
  prefix?: string;
}

export interface ContainerDetail {
  name: string;
  image: string;
  imagePullPolicy?: string;
  ports?: ContainerPort[];
  env?: ContainerEnvVar[];
  envFrom?: ContainerEnvFromSource[];
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    readOnly?: boolean;
  }>;
}

export interface SetEnvItem {
  name: string;
  value?: string;
  remove?: boolean;
}

export interface SetEnvPayload {
  pod: string;
  namespace: string;
  container?: string;
  env: SetEnvItem[];
  context?: string;
}

export interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  image: string;
  imageID?: string;
  containerID?: string;
  state?: {
    running?: { startedAt?: string };
    waiting?: { reason?: string; message?: string };
    terminated?: { exitCode?: number; reason?: string; finishedAt?: string };
  };
}

export interface PodCondition {
  type: string;
  status: string;
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

export interface PodItem {
  metadata: KubeMetadata;
  status: {
    phase: string;
    podIP?: string;
    podIPs?: Array<{ ip: string }>;
    hostIP?: string;
    startTime?: string;
    qosClass?: string;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
    conditions?: PodCondition[];
  };
  spec: {
    nodeName?: string;
    serviceAccountName?: string;
    initContainers?: ContainerDetail[];
    containers: ContainerDetail[];
    volumes?: Array<{ name: string; [key: string]: any }>;
    restartPolicy?: string;
  };
}

export interface DeploymentItem {
  metadata: KubeMetadata;
  spec: {
    replicas: number;
    selector?: any;
    template?: {
      metadata?: KubeMetadata;
      spec?: {
        containers?: ContainerDetail[];
        initContainers?: ContainerDetail[];
        [key: string]: any;
      };
      [key: string]: any;
    };
  };
  status: {
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
  };
}

export interface NodeItem {
  metadata: KubeMetadata;
  spec?: {
    unschedulable?: boolean;
    taints?: Array<{ key: string; value?: string; effect: string }>;
  };
  status: {
    addresses?: Array<{ type: string; address: string }>;
    nodeInfo?: {
      kubeletVersion: string;
      osImage: string;
      operatingSystem: string;
      architecture: string;
    };
    conditions?: Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }>;
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
}

export interface ServiceItem {
  metadata: KubeMetadata;
  spec: {
    type: string;
    clusterIP?: string;
    ports?: Array<{
      name?: string;
      port: number;
      targetPort: number | string;
      protocol: string;
    }>;
    selector?: Record<string, string>;
  };
  status?: {
    loadBalancer?: {
      ingress?: Array<{ ip?: string; hostname?: string }>;
    };
  };
}

export interface EventItem {
  metadata: KubeMetadata;
  type: string;
  reason: string;
  message: string;
  involvedObject: {
    kind: string;
    name: string;
    namespace?: string;
  };
  lastTimestamp?: string;
  eventTime?: string;
}

export interface ConfigMapItem {
  metadata: KubeMetadata;
  data?: Record<string, string>;
}

export interface SecretItem {
  metadata: KubeMetadata;
  type: string;
  data?: Record<string, string>;
}

export interface IngressBackend {
  service?: {
    name: string;
    port?: {
      number?: number;
      name?: string;
    };
  };
  resource?: {
    apiGroup?: string;
    kind: string;
    name: string;
  };
}

export interface IngressPath {
  path?: string;
  pathType?: string;
  backend: IngressBackend;
}

export interface IngressRule {
  host?: string;
  http?: {
    paths: IngressPath[];
  };
}

export interface IngressTLS {
  hosts?: string[];
  secretName?: string;
}

export interface IngressLoadBalancerEndpoint {
  ip?: string;
  hostname?: string;
  ports?: Array<{
    port: number;
    protocol: string;
    error?: string;
  }>;
}

export interface IngressItem {
  metadata: KubeMetadata;
  spec?: {
    ingressClassName?: string;
    defaultBackend?: IngressBackend;
    rules?: IngressRule[];
    tls?: IngressTLS[];
  };
  status?: {
    loadBalancer?: {
      ingress?: IngressLoadBalancerEndpoint[];
    };
  };
}

export interface StatefulSetItem {
  metadata: KubeMetadata;
  spec: {
    replicas: number;
    serviceName?: string;
    template?: {
      metadata?: KubeMetadata;
      spec?: {
        containers?: ContainerDetail[];
        initContainers?: ContainerDetail[];
        [key: string]: any;
      };
      [key: string]: any;
    };
    [key: string]: any;
  };
  status: {
    replicas?: number;
    readyReplicas?: number;
    currentReplicas?: number;
    updatedReplicas?: number;
  };
}

export interface DaemonSetItem {
  metadata: KubeMetadata;
  spec: {
    template?: {
      metadata?: KubeMetadata;
      spec?: {
        nodeSelector?: Record<string, string>;
        containers?: ContainerDetail[];
        [key: string]: any;
      };
      [key: string]: any;
    };
    [key: string]: any;
  };
  status: {
    desiredNumberScheduled?: number;
    currentNumberScheduled?: number;
    numberReady?: number;
    updatedNumberScheduled?: number;
    numberAvailable?: number;
    numberMisscheduled?: number;
  };
}

export interface JobCondition {
  type: string;
  status: string;
  lastProbeTime?: string;
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

export interface JobItem {
  metadata: KubeMetadata;
  spec: {
    completions?: number;
    parallelism?: number;
    backoffLimit?: number;
    template?: {
      spec?: {
        containers?: ContainerDetail[];
        restartPolicy?: string;
        [key: string]: any;
      };
    };
  };
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: JobCondition[];
  };
}

export interface CronJobItem {
  metadata: KubeMetadata;
  spec: {
    schedule: string;
    suspend?: boolean;
    concurrencyPolicy?: string;
    successfulJobsHistoryLimit?: number;
    failedJobsHistoryLimit?: number;
    jobTemplate?: {
      spec?: JobItem['spec'];
    };
  };
  status?: {
    active?: Array<{ name: string; namespace?: string }>;
    lastScheduleTime?: string;
    lastSuccessfulTime?: string;
  };
}

export interface PersistentVolumeClaimItem {
  metadata: KubeMetadata;
  spec: {
    accessModes?: string[];
    resources?: {
      requests?: {
        storage?: string;
      };
    };
    volumeName?: string;
    storageClassName?: string;
    volumeMode?: string;
  };
  status?: {
    phase?: string;
    capacity?: {
      storage?: string;
    };
    accessModes?: string[];
  };
}

export interface PersistentVolumeItem {
  metadata: KubeMetadata;
  spec: {
    capacity?: {
      storage?: string;
    };
    accessModes?: string[];
    claimRef?: {
      namespace?: string;
      name?: string;
    };
    persistentVolumeReclaimPolicy?: string;
    storageClassName?: string;
    volumeMode?: string;
  };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
  };
}

export interface StorageClassItem {
  metadata: KubeMetadata;
  provisioner: string;
  reclaimPolicy?: string;
  volumeBindingMode?: string;
  allowVolumeExpansion?: boolean;
  parameters?: Record<string, string>;
}

export interface NamespaceItem {
  metadata: KubeMetadata;
  status?: {
    phase?: string;
  };
}


export interface ReplicaSetItem {
  metadata: KubeMetadata;
  spec: {
    replicas?: number;
    template?: {
      spec?: { containers?: Array<{ name: string; image: string }> };
    };
  };
  status: { replicas?: number; readyReplicas?: number };
}

export interface CustomResourceDefinitionItem {
  metadata: KubeMetadata;
  spec: {
    group: string;
    scope: 'Namespaced' | 'Cluster';
    names: { kind: string; plural: string; singular?: string; shortNames?: string[] };
    versions: Array<{
      name: string;
      served: boolean;
      storage: boolean;
      additionalPrinterColumns?: Array<{ name: string; type: string; jsonPath: string; priority?: number }>;
    }>;
  };
}

import type {
  AwsConnection,
  EcsServiceDiagnostics,
  EksClusterDetail,
  EksNodegroupSummary,
  GeneratedArtifact,
  ObservabilityFinding,
  ObservabilityPostureArea,
  ObservabilityPostureReport,
  ObservabilityRecommendation,
  ResilienceExperimentSuggestion,
  TerraformDriftReport,
  TerraformProject
} from '@shared/types'
import { getTerraformDriftReport } from '../terraformDrift'
import { getProject } from '../terraform'
import { createTempEksKubeconfig, describeEksCluster, getEksMetricsSnapshot, listEksNodegroups, type EksMetricsSnapshot } from './eks'
import { getServiceDiagnostics } from './ecs'
import { logWarn } from '../observability'

function connectionRef(connection: AwsConnection) {
  return {
    kind: connection.kind,
    label: connection.label,
    profile: connection.profile,
    region: connection.region,
    sessionId: connection.sessionId
  }
}

function toneFromScore(score: number): 'good' | 'mixed' | 'weak' {
  if (score >= 0.75) return 'good'
  if (score >= 0.45) return 'mixed'
  return 'weak'
}

function severityRank(severity: ObservabilityFinding['severity']): number {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[severity]
}

function buildArtifact(
  id: string,
  title: string,
  type: GeneratedArtifact['type'],
  language: GeneratedArtifact['language'],
  summary: string,
  content: string,
  safety: string,
  isRunnable = false,
  copyLabel = 'Copy artifact',
  runLabel = 'Run in terminal'
): GeneratedArtifact {
  return { id, title, type, language, summary, content, safety, isRunnable, copyLabel, runLabel }
}

function sortReport(report: ObservabilityPostureReport): ObservabilityPostureReport {
  return {
    ...report,
    findings: [...report.findings].sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
  }
}

function buildSummary(items: Array<{ id: string; label: string; ok: number; total: number; goodDetail: string; weakDetail: string }>): ObservabilityPostureArea[] {
  return items.map((item) => {
    const ratio = item.total === 0 ? 0 : item.ok / item.total
    return {
      id: item.id,
      label: item.label,
      value: `${item.ok}/${item.total}`,
      tone: toneFromScore(ratio),
      detail: ratio >= 0.75 ? item.goodDetail : item.weakDetail
    }
  })
}

function pushRecommendationArtifacts(
  recommendations: ObservabilityRecommendation[],
  experiments: ResilienceExperimentSuggestion[]
): GeneratedArtifact[] {
  return [
    ...recommendations.flatMap((item) => (item.artifact ? [item.artifact] : [])),
    ...experiments.flatMap((item) => (item.artifact ? [item.artifact] : []))
  ]
}

function makeEksOtelYaml(clusterName: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: observability
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  collector.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
          http:
    processors:
      batch:
    exporters:
      logging:
        loglevel: info
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [logging]
        metrics:
          receivers: [otlp]
          processors: [batch]
          exporters: [logging]
        logs:
          receivers: [otlp]
          processors: [batch]
          exporters: [logging]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
spec:
  replicas: 1
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
        infra-lens.scope: "${clusterName}"
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.103.1
          args: ["--config=/conf/collector.yaml"]
          ports:
            - containerPort: 4317
            - containerPort: 4318
          volumeMounts:
            - name: config
              mountPath: /conf
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
`
}

function makeEcsOtelSidecar(serviceName: string, region: string): string {
  return JSON.stringify(
    {
      name: 'aws-otel-collector',
      image: 'public.ecr.aws/aws-observability/aws-otel-collector:latest',
      essential: false,
      cpu: 64,
      memoryReservation: 128,
      portMappings: [
        { containerPort: 4317, protocol: 'tcp' },
        { containerPort: 4318, protocol: 'tcp' }
      ],
      environment: [
        { name: 'AWS_REGION', value: region },
        { name: 'AOT_CONFIG_CONTENT', value: 'receivers:\n  otlp:\n    protocols:\n      grpc:\n      http:\nexporters:\n  logging:\nprocessors:\n  batch:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [logging]' }
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': `/ecs/${serviceName}/otel`,
          'awslogs-region': region,
          'awslogs-stream-prefix': 'otel'
        }
      }
    },
    null,
    2
  )
}

function makeAwsLogsConfig(serviceName: string, region: string): string {
  return JSON.stringify(
    {
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': `/ecs/${serviceName}`,
          'awslogs-region': region,
          'awslogs-stream-prefix': 'app'
        }
      }
    },
    null,
    2
  )
}

function makeFisJson(scopeName: string): string {
  return JSON.stringify(
    {
      description: `Resilience experiment template for ${scopeName}`,
      stopConditions: [{ source: 'none' }],
      actions: {
        stop_one_target: {
          actionId: 'aws:ecs:stop-task',
          description: 'Stop a single running target to verify alarms and rollout behavior.',
          parameters: { reason: 'infra-lens resilience lab validation' },
          targets: { Tasks: 'oneRandomTask' }
        }
      },
      targets: {
        oneRandomTask: {
          resourceType: 'aws:ecs:task',
          selectionMode: 'COUNT(1)',
          resourceTags: { scope: scopeName }
        }
      },
      roleArn: 'arn:aws:iam::<account-id>:role/AWSFISExperimentRole'
    },
    null,
    2
  )
}

function makeTerraformAlarmSnippet(name: string): string {
  return `resource "aws_cloudwatch_metric_alarm" "cpu_high_${name.replace(/[^a-zA-Z0-9_]/g, '_')}" {
  alarm_name          = "${name}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Operator-generated baseline alarm for ${name}"
  treat_missing_data  = "missing"
}`
}

function makeTerraformLogRetentionSnippet(name: string): string {
  return `resource "aws_cloudwatch_log_group" "service_logs_${name.replace(/[^a-zA-Z0-9_]/g, '_')}" {
  name              = "/infra-lens/${name}"
  retention_in_days = 30
}`
}

function summarizeEksMetrics(snapshot: EksMetricsSnapshot): { ok: number; total: number; detail: string } {
  if (!snapshot.metricsAvailable) {
    return {
      ok: 0,
      total: 1,
      detail: 'metrics-server or metrics.k8s.io is not reachable from the current operator context.'
    }
  }

  const pressureNodes = snapshot.highCpuNodeCount + snapshot.highMemoryNodeCount
  if (pressureNodes > 0) {
    return {
      ok: Math.max(snapshot.nodes.length - pressureNodes, 0),
      total: Math.max(snapshot.nodes.length, 1),
      detail: `${snapshot.highCpuNodeCount} high-CPU and ${snapshot.highMemoryNodeCount} high-memory nodes detected from live metrics.`
    }
  }

  return {
    ok: Math.max(snapshot.nodes.length, 1),
    total: Math.max(snapshot.nodes.length, 1),
    detail: snapshot.metricsMessage
  }
}

export async function generateEksObservabilityReport(
  connection: AwsConnection,
  clusterName: string
): Promise<ObservabilityPostureReport> {
  const [cluster, nodegroups] = await Promise.all([
    describeEksCluster(connection, clusterName),
    listEksNodegroups(connection, clusterName)
  ])

  let kubectlReady = false
  let kubectlMessage = ''
  let metricsSnapshot: EksMetricsSnapshot = {
    metricsAvailable: false,
    metricsMessage: 'Live cluster metrics were not checked.',
    nodes: [],
    topPods: [],
    highCpuNodeCount: 0,
    highMemoryNodeCount: 0
  }
  try {
    const session = await createTempEksKubeconfig(connection, clusterName)
    kubectlReady = Boolean(session.path)
    kubectlMessage = session.output || `Prepared kubeconfig at ${session.path}`
    if (kubectlReady) {
      metricsSnapshot = await getEksMetricsSnapshot(connection, session.path)
    }
  } catch (error) {
    kubectlMessage = error instanceof Error ? error.message : String(error)
  }

  const metricsSummary = summarizeEksMetrics(metricsSnapshot)
  const findings = buildEksFindings(cluster, nodegroups, kubectlReady, kubectlMessage, metricsSnapshot)
  const recommendations = buildEksRecommendations(connection.region, cluster, findings)
  const experiments = buildEksExperiments(cluster.name)
  const artifacts = pushRecommendationArtifacts(recommendations, experiments)

  return sortReport({
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'eks',
      connection: connectionRef(connection),
      clusterName
    },
    summary: buildSummary([
      {
        id: 'logs',
        label: 'Logs',
        ok: cluster.loggingEnabled.length > 0 ? 1 : 0,
        total: 1,
        goodDetail: `Control plane logs enabled: ${cluster.loggingEnabled.join(', ')}`,
        weakDetail: 'Control plane logging is limited or disabled.'
      },
      {
        id: 'metrics',
        label: 'Metrics',
        ok: metricsSummary.ok,
        total: metricsSummary.total,
        goodDetail: metricsSummary.detail,
        weakDetail: metricsSummary.detail
      },
      {
        id: 'traces',
        label: 'Trace Readiness',
        ok: cluster.oidcIssuer !== '-' ? 1 : 0,
        total: 1,
        goodDetail: 'OIDC exists, so IRSA-based collector/workload telemetry is feasible.',
        weakDetail: 'Trace path appears incomplete; collector/workload instrumentation is not visible.'
      },
      {
        id: 'deployment',
        label: 'Deployment Resilience',
        ok: nodegroups.filter((item) => Number(item.max) > Number(item.desired)).length,
        total: Math.max(nodegroups.length, 1),
        goodDetail: 'At least some nodegroups have burst headroom.',
        weakDetail: 'Nodegroups show limited scale-out or redundancy headroom.'
      },
      {
        id: 'rollback',
        label: 'Rollback Readiness',
        ok: kubectlReady ? 1 : 0,
        total: 1,
        goodDetail: 'kubectl session can be prepared from the current operator context.',
        weakDetail: 'kubectl session preparation failed, so rollback execution may be delayed.'
      }
    ]),
    findings,
    recommendations,
    experiments,
    artifacts,
    safetyNotes: [
      {
        title: 'Generated manifests only',
        blastRadius: 'No live cluster mutation is performed by the analysis flow.',
        prerequisites: ['kubectl access only if you choose to apply generated YAML'],
        rollback: 'Delete generated namespace/deployment or revert annotations/patches.'
      },
      {
        title: 'Chaos suggestions are optional',
        blastRadius: 'Experiment templates can impact one namespace, one workload, or one task when executed.',
        prerequisites: ['Review blast radius before running any experiment', 'Stage in non-production first'],
        rollback: 'Scale workloads back, revert network rules, or redeploy the affected release.'
      }
    ],
    correlatedSignals: [
      {
        id: 'eks-timeline',
        title: 'Change Timeline',
        detail: 'Use the existing CloudTrail-backed timeline to correlate control plane changes.',
        serviceId: 'eks',
        targetView: 'timeline'
      },
      {
        id: 'cloudtrail',
        title: 'CloudTrail',
        detail: 'Cluster update and access-path changes can be cross-checked in CloudTrail.',
        serviceId: 'cloudtrail',
        targetView: 'overview'
      }
    ]
  })
}

function buildEksFindings(
  cluster: EksClusterDetail,
  nodegroups: EksNodegroupSummary[],
  kubectlReady: boolean,
  kubectlMessage: string,
  metricsSnapshot: EksMetricsSnapshot
): ObservabilityFinding[] {
  const findings: ObservabilityFinding[] = []

  if (cluster.loggingEnabled.length < 3) {
    findings.push({
      id: 'eks-control-plane-logging',
      title: 'Control plane logging coverage is partial',
      severity: 'medium',
      category: 'logs',
      summary: 'Not all major EKS control plane log types are enabled.',
      detail: 'api, audit, authenticator, controllerManager, and scheduler logs are the baseline for operator troubleshooting. Current coverage is narrower.',
      evidence: [cluster.loggingEnabled.length ? `Enabled logs: ${cluster.loggingEnabled.join(', ')}` : 'No enabled control plane logs reported'],
      impact: 'Incident triage and auth/deployment debugging will have blind spots.',
      inference: false,
      recommendedActionIds: ['eks-enable-logging']
    })
  }

  if (cluster.endpointPublicAccess && !cluster.endpointPrivateAccess) {
    findings.push({
      id: 'eks-endpoint-posture',
      title: 'Cluster API endpoint is primarily public',
      severity: 'medium',
      category: 'deployment',
      summary: 'Public-only access increases exposure and complicates controlled ops paths.',
      detail: 'This is not inherently wrong, but private access usually improves operator resiliency and limits accidental exposure.',
      evidence: [
        `endpointPublicAccess=${String(cluster.endpointPublicAccess)}`,
        `endpointPrivateAccess=${String(cluster.endpointPrivateAccess)}`,
        `publicAccessCidrs=${cluster.publicAccessCidrs.join(', ') || 'none'}`
      ],
      impact: 'Operational access depends more heavily on public networking and CIDR hygiene.',
      inference: false,
      recommendedActionIds: ['eks-review-endpoint-posture']
    })
  }

  if (nodegroups.length > 0 && nodegroups.every((item) => Number(item.max) <= Number(item.desired))) {
    findings.push({
      id: 'eks-nodegroup-headroom',
      title: 'Nodegroups have little visible surge headroom',
      severity: 'high',
      category: 'deployment',
      summary: 'All discovered nodegroups appear capped at current desired capacity.',
      detail: 'During failed rollouts or zonal issues, lack of extra capacity can slow recovery and skew resilience experiments.',
      evidence: nodegroups.map((item) => `${item.name}: desired=${item.desired}, max=${item.max}`),
      impact: 'Rollouts and remediation may compete for the same scarce capacity.',
      inference: false,
      recommendedActionIds: ['eks-scale-headroom']
    })
  }

  findings.push({
    id: 'eks-app-telemetry-inference',
    title: 'Application trace pipeline is not visible from cluster metadata',
    severity: 'medium',
    category: 'traces',
    summary: 'Current EKS APIs show cluster posture, not workload-level OTel instrumentation.',
    detail: 'This is an inference. The analysis cannot prove traces are absent without inspecting workloads, but no collector/workload telemetry evidence is visible from the current metadata path.',
    evidence: ['No workload manifest inspection was performed in the MVP flow', `kubectl session preparation: ${kubectlMessage}`],
    impact: 'Trace readiness for namespace/workload debugging may be lower than expected.',
    inference: true,
    recommendedActionIds: ['eks-generate-otel']
  })

  if (!metricsSnapshot.metricsAvailable) {
    findings.push({
      id: 'eks-metrics-server-unavailable',
      title: 'Live resource metrics are not available from the cluster',
      severity: kubectlReady ? 'medium' : 'high',
      category: 'metrics',
      summary: 'The analysis could not query metrics.k8s.io, so CPU and memory posture is partially blind.',
      detail: 'This usually means Metrics Server is missing, unhealthy, or blocked by RBAC/networking. Without live usage data, scale and saturation judgments remain incomplete.',
      evidence: [metricsSnapshot.metricsMessage || 'metrics.k8s.io query failed'],
      impact: 'Node and workload saturation can build without clear operator visibility in the current flow.',
      inference: false,
      recommendedActionIds: ['eks-enable-metrics-server']
    })
  }

  if (metricsSnapshot.metricsAvailable && (metricsSnapshot.highCpuNodeCount > 0 || metricsSnapshot.highMemoryNodeCount > 0)) {
    const hotNodes = metricsSnapshot.nodes
      .filter((node) => (node.cpuPercent ?? 0) >= 80 || (node.memoryPercent ?? 0) >= 80)
      .slice(0, 5)
      .map((node) => `${node.name}: cpu=${node.cpuUsage}/${node.cpuPercent ?? '?'}%, mem=${node.memoryUsage}/${node.memoryPercent ?? '?'}%`)
    const topPods = metricsSnapshot.topPods
      .slice(0, 3)
      .map((pod) => `${pod.namespace}/${pod.name}: cpu=${pod.cpuUsage}, mem=${pod.memoryUsage}`)

    findings.push({
      id: 'eks-live-resource-pressure',
      title: 'Live cluster metrics show elevated CPU or memory pressure',
      severity: metricsSnapshot.highCpuNodeCount + metricsSnapshot.highMemoryNodeCount >= 2 ? 'high' : 'medium',
      category: 'metrics',
      summary: 'At least one node is already running hot based on current `kubectl top` data.',
      detail: 'This is a live point-in-time signal from Metrics Server, not a long-window trend. It is still useful for spotting immediate headroom issues before resilience changes.',
      evidence: [
        `${metricsSnapshot.highCpuNodeCount} nodes at >=80% CPU`,
        `${metricsSnapshot.highMemoryNodeCount} nodes at >=80% memory`,
        ...hotNodes,
        ...topPods
      ],
      impact: 'Resilience drills, rollouts, or recovery events may contend with existing saturation and produce misleading results.',
      inference: false,
      recommendedActionIds: ['eks-scale-headroom']
    })
  }

  if (!kubectlReady) {
    findings.push({
      id: 'eks-kubectl-access',
      title: 'kubectl session could not be prepared',
      severity: 'high',
      category: 'rollback',
      summary: 'The current operator context could not generate a working kubeconfig session.',
      detail: 'Rollback and ad-hoc diagnostics depend on the same access path used by existing EKS terminal flows.',
      evidence: [kubectlMessage],
      impact: 'Rollback or live verification will require fixing access first.',
      inference: false,
      recommendedActionIds: ['eks-fix-kubectl']
    })
  }

  return findings
}

function buildEksRecommendations(region: string, cluster: EksClusterDetail, findings: ObservabilityFinding[]): ObservabilityRecommendation[] {
  const otelYaml = makeEksOtelYaml(cluster.name)
  const otelApply = buildArtifact(
    'eks-otel-yaml',
    'Minimal OTel Collector YAML',
    'yaml',
    'yaml',
    'Preview-only collector deployment for namespace-level telemetry bootstrap.',
    otelYaml,
    'Apply only after reviewing RBAC, destination exporters, and namespace choice.',
    false,
    'Copy YAML',
    'Run kubectl apply'
  )

  const loggingCommand = buildArtifact(
    'eks-enable-logging-command',
    'CloudWatch Logging Command',
    'shell-command',
    'bash',
    'AWS CLI template to expand EKS control plane logging.',
    `aws eks update-cluster-config --name "${cluster.name}" --region "${region}" --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'`,
    'Cluster config changes affect control plane telemetry only; review maintenance expectations first.'
  )

  const endpointReview = buildArtifact(
    'eks-endpoint-review-command',
    'Endpoint Posture Check',
    'shell-command',
    'bash',
    'Read-only command to re-check endpoint exposure and public CIDRs.',
    `aws eks describe-cluster --name "${cluster.name}" --region "${region}" --query 'cluster.resourcesVpcConfig.{public:endpointPublicAccess,private:endpointPrivateAccess,cidrs:publicAccessCidrs}'`,
    'Read-only.'
  )

  const metricsServerCheck = buildArtifact(
    'eks-metrics-api-check',
    'Metrics API Check',
    'shell-command',
    'bash',
    'Read-only command to verify metrics.k8s.io and current node usage from kubectl.',
    'kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes && kubectl top nodes',
    'Read-only. Requires kubectl access and a working Metrics Server deployment.'
  )

  const recommendations: ObservabilityRecommendation[] = [
    {
      id: 'eks-enable-logging',
      title: 'Expand EKS control plane logging',
      type: 'command',
      summary: 'Enable the full EKS control plane log set before deeper telemetry work.',
      rationale: 'Control plane logs are the lowest-friction observability surface already supported by AWS.',
      expectedBenefit: 'Improves audit, scheduler, and auth visibility during incidents.',
      risk: 'Slightly higher CloudWatch ingest/storage cost.',
      rollback: 'Re-run update-cluster-config with a smaller enabled log set.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install'],
      artifact: loggingCommand
    },
    {
      id: 'eks-generate-otel',
      title: 'Generate a minimal OpenTelemetry collector deployment',
      type: 'yaml',
      summary: 'Start with generator output instead of installing a full operator stack.',
      rationale: 'The MVP favors snippet generation over mandatory agent/operator deployment.',
      expectedBenefit: 'Creates a reviewable path toward traces, logs, and metrics collection.',
      risk: 'Applying unchanged defaults may not route data to your desired backend.',
      rollback: 'Delete the `observability` namespace or the generated deployment/configmap.',
      prerequisiteLevel: 'optional',
      setupEffort: 'low',
      labels: ['Optional setup', 'Generated manifest'],
      artifact: otelApply
    },
    {
      id: 'eks-review-endpoint-posture',
      title: 'Review API endpoint exposure before resilience changes',
      type: 'manual-check',
      summary: 'Treat network reachability and private access as part of rollback readiness.',
      rationale: 'Rollback paths fail when operator access depends on a fragile public route.',
      expectedBenefit: 'Reduces the chance that a deployment issue becomes an access issue.',
      risk: 'Endpoint changes can affect existing automation paths.',
      rollback: 'Restore the previous endpointPublicAccess/privateAccess configuration.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install'],
      artifact: endpointReview
    },
    {
      id: 'eks-enable-metrics-server',
      title: 'Restore cluster metrics visibility',
      type: 'manual-check',
      summary: 'Verify Metrics Server is installed and that `metrics.k8s.io` is reachable from the current operator path.',
      rationale: 'The resilience lab can now sample live CPU and memory usage, but only when the cluster exposes Metrics Server data.',
      expectedBenefit: 'Improves saturation detection before scale, rollout, and rollback changes.',
      risk: 'Metrics Server rollout or RBAC changes can affect existing cluster add-on posture.',
      rollback: 'Revert the add-on deployment or restore the previous RBAC/network policy state.',
      prerequisiteLevel: 'optional',
      setupEffort: 'low',
      labels: ['kubectl required', 'Read-only verification first'],
      artifact: metricsServerCheck
    }
  ]

  if (findings.some((item) => item.id === 'eks-nodegroup-headroom')) {
    recommendations.push({
      id: 'eks-scale-headroom',
      title: 'Preserve nodegroup surge headroom',
      type: 'manual-check',
      summary: 'Keep max size above desired size on at least one worker lane.',
      rationale: 'Resilience tests and failed rollouts need spare capacity to avoid false negatives.',
      expectedBenefit: 'Improves deploy/rollback elasticity and reduces saturation during recovery.',
      risk: 'Higher possible spend if autoscaling expands.',
      rollback: 'Return max sizes to current baselines after validating rollout behavior.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install']
    })
  }

  if (findings.some((item) => item.id === 'eks-kubectl-access')) {
    recommendations.push({
      id: 'eks-fix-kubectl',
      title: 'Restore kubectl session readiness',
      type: 'manual-check',
      summary: 'Use the existing prepareEksKubectlSession flow as the first rollback dependency.',
      rationale: 'Generated manifests and safe commands only help if the current operator can reach the cluster.',
      expectedBenefit: 'Improves rollback execution confidence.',
      risk: 'Credentials or kubeconfig changes may impact current local contexts.',
      rollback: 'Remove temporary kubeconfig entries or revert the assumed role/session selection.',
      prerequisiteLevel: 'required',
      setupEffort: 'low',
      labels: ['Requires existing AWS CLI path']
    })
  }

  return recommendations
}

function buildEksExperiments(clusterName: string): ResilienceExperimentSuggestion[] {
  return [
    {
      id: 'eks-pod-failure',
      title: 'Pod Failure Drill',
      summary: 'Delete one replica from a non-critical workload and verify recovery signals.',
      hypothesis: 'The workload should self-heal and emit logs/alerts within the expected SLO window.',
      blastRadius: 'Single workload or namespace.',
      prerequisites: ['Choose a low-risk namespace', 'Confirm PodDisruptionBudget and HPA expectations'],
      rollback: 'Redeploy or scale the workload back to the pre-test replica count.',
      setupEffort: 'none',
      prerequisiteLevel: 'none',
      artifact: buildArtifact(
        'eks-pod-chaos-command',
        'kubectl Pod Failure Command',
        'shell-command',
        'bash',
        'Read/write command template for a bounded pod failure drill.',
        'kubectl delete pod -n <namespace> <pod-name>',
        'Deletes one pod only. Validate namespace and workload selection before execution.'
      )
    },
    {
      id: 'eks-fis-template',
      title: 'FIS experiment template for EKS-aligned checks',
      summary: 'Generate a JSON template instead of forcing immediate FIS integration.',
      hypothesis: 'A bounded task/workload disruption should surface telemetry and rollback gaps quickly.',
      blastRadius: 'Single target selected by the final template.',
      prerequisites: ['AWS FIS IAM role', 'Review target selection and stop conditions'],
      rollback: 'Stop the experiment and redeploy the impacted workload if validation fails.',
      setupEffort: 'medium',
      prerequisiteLevel: 'optional',
      artifact: buildArtifact(
        'eks-fis-json',
        'FIS Template JSON',
        'json-template',
        'json',
        'Starter JSON for a bounded resilience experiment.',
        makeFisJson(clusterName),
        'Optional enhancement. Requires AWS FIS role and final target review.'
      )
    }
  ]
}

export async function generateEcsObservabilityReport(
  connection: AwsConnection,
  clusterArn: string,
  serviceName: string
): Promise<ObservabilityPostureReport> {
  const diagnostics = await getServiceDiagnostics(connection, clusterArn, serviceName)
  const findings = buildEcsFindings(diagnostics)
  const recommendations = buildEcsRecommendations(connection.region, diagnostics, findings)
  const experiments = buildEcsExperiments(serviceName)
  const artifacts = pushRecommendationArtifacts(recommendations, experiments)
  const withLogs = diagnostics.logTargets.filter((item) => item.available).length
  const totalContainers = diagnostics.taskRows.reduce((sum, task) => sum + task.containers.length, 0)
  const telemetryContainers = diagnostics.taskDefinition?.containerImages.filter((container) =>
    /otel|open-telemetry|xray/i.test(container.name) || /otel|open-telemetry|xray/i.test(container.image)
  ).length ?? 0

  return sortReport({
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'ecs',
      connection: connectionRef(connection),
      clusterArn,
      serviceName
    },
    summary: buildSummary([
      {
        id: 'logs',
        label: 'Logs',
        ok: withLogs,
        total: Math.max(totalContainers, 1),
        goodDetail: 'awslogs targets are visible for most containers.',
        weakDetail: 'Some containers have no visible awslogs target.'
      },
      {
        id: 'metrics',
        label: 'Metrics',
        ok: diagnostics.summaryTiles.filter((tile) => /running|healthy/i.test(tile.label)).length,
        total: Math.max(diagnostics.summaryTiles.length, 1),
        goodDetail: 'Deployment metrics and task health summaries are already available.',
        weakDetail: 'Service-level health exists, but monitoring baselines appear thin.'
      },
      {
        id: 'traces',
        label: 'Trace Readiness',
        ok: telemetryContainers,
        total: Math.max((diagnostics.taskDefinition?.containerImages.length ?? 0), 1),
        goodDetail: 'A telemetry sidecar or related image is present in the task definition.',
        weakDetail: 'No obvious OTel/trace sidecar is visible in the task definition.'
      },
      {
        id: 'deployment',
        label: 'Deployment Resilience',
        ok: diagnostics.service.runningCount,
        total: Math.max(diagnostics.service.desiredCount, 1),
        goodDetail: 'Running count is near desired baseline.',
        weakDetail: 'Running count is below desired or rollout is unstable.'
      },
      {
        id: 'rollback',
        label: 'Rollback Readiness',
        ok: diagnostics.service.deployments.length > 1 ? 1 : 0,
        total: 1,
        goodDetail: 'Multiple deployments provide a visible rollback reference.',
        weakDetail: 'Only one visible deployment revision; rollback posture may depend on re-deploying current config.'
      }
    ]),
    findings,
    recommendations,
    experiments,
    artifacts,
    safetyNotes: [
      {
        title: 'Generator-first ECS workflow',
        blastRadius: 'No task definition or service update is applied by the analysis itself.',
        prerequisites: ['Review JSON snippets before registering a new task definition revision'],
        rollback: 'Revert to the previous task definition revision or run a force deployment on the prior revision.'
      },
      {
        title: 'Resilience checks should stay bounded',
        blastRadius: 'Prefer single-task experiments before scaling into broader degradation tests.',
        prerequisites: ['Confirmed alarm or dashboard target', 'Run during a safe maintenance window when needed'],
        rollback: 'Force deployment or set desired count back to the pre-test value.'
      }
    ],
    correlatedSignals: [
      {
        id: 'ecs-services',
        title: 'ECS diagnostics',
        detail: 'This report reuses the existing ECS diagnostics summary, indicators, tasks, and logs.',
        serviceId: 'ecs',
        targetView: 'services'
      },
      {
        id: 'cloudwatch-logs',
        title: 'CloudWatch logs',
        detail: 'Use existing log targets to inspect task/container output after remediation or experiments.',
        serviceId: 'cloudwatch',
        targetView: 'logs'
      }
    ]
  })
}

function buildEcsFindings(diagnostics: EcsServiceDiagnostics): ObservabilityFinding[] {
  const findings: ObservabilityFinding[] = []
  const noLogs = diagnostics.logTargets.length > 0 && diagnostics.logTargets.every((item) => !item.available)
  const repeatedFailures = diagnostics.failedTasks.length >= 3
  const telemetrySidecarPresent = diagnostics.taskDefinition?.containerImages.some((container) =>
    /otel|open-telemetry|xray/i.test(container.name) || /otel|open-telemetry|xray/i.test(container.image)
  ) ?? false

  if (diagnostics.service.runningCount < diagnostics.service.desiredCount) {
    findings.push({
      id: 'ecs-running-gap',
      title: 'Service is under desired count',
      severity: 'high',
      category: 'deployment',
      summary: 'The service is not meeting desired capacity.',
      detail: 'This is the clearest resilience signal in the current service posture because deploy and rollback both depend on task replacement keeping up.',
      evidence: [`running=${diagnostics.service.runningCount}`, `desired=${diagnostics.service.desiredCount}`],
      impact: 'Reduced availability and lower confidence in rollout recovery.',
      inference: false,
      recommendedActionIds: ['ecs-force-deploy-checklist', 'ecs-scale-review']
    })
  }

  if (repeatedFailures) {
    findings.push({
      id: 'ecs-repeated-failures',
      title: 'Repeated stopped tasks were detected',
      severity: 'critical',
      category: 'deployment',
      summary: 'Recent stopped tasks suggest a recurring failure pattern.',
      detail: 'The report reuses existing diagnostics failure rows, including non-zero exits and unhealthy targets.',
      evidence: diagnostics.failedTasks.slice(0, 5).map((task) => `${task.taskId}: ${task.stoppedReason || task.healthStatus}`),
      impact: 'Recovery loops may continue unless the root cause is observed through logs and telemetry.',
      inference: false,
      recommendedActionIds: ['ecs-force-deploy-checklist']
    })
  }

  if (noLogs) {
    findings.push({
      id: 'ecs-missing-logs',
      title: 'No awslogs target is visible for current containers',
      severity: 'high',
      category: 'logs',
      summary: 'Container log configuration appears absent from the task definition path used by diagnostics.',
      detail: 'Without log groups/streams, repeated task failures are harder to root-cause from the current UI surface.',
      evidence: diagnostics.logTargets.slice(0, 5).map((item) => `${item.containerName}: ${item.reason}`),
      impact: 'Operator triage depends on ECS events only, which is usually insufficient for runtime failures.',
      inference: false,
      recommendedActionIds: ['ecs-add-awslogs']
    })
  }

  if (!telemetrySidecarPresent) {
    findings.push({
      id: 'ecs-trace-inference',
      title: 'Trace pipeline is not obvious in the task definition',
      severity: 'medium',
      category: 'traces',
      summary: 'No OTel collector or similar telemetry sidecar signature is visible.',
      detail: 'This is an inference from container names/images in the current task definition. Instrumentation could still exist in-app.',
      evidence: diagnostics.taskDefinition?.containerImages.map((container) => `${container.name}: ${container.image}`) ?? ['Task definition unavailable'],
      impact: 'Trace-based debugging and latency attribution may be incomplete.',
      inference: true,
      recommendedActionIds: ['ecs-add-otel-sidecar']
    })
  }

  if (diagnostics.service.deployments.length <= 1) {
    findings.push({
      id: 'ecs-rollback-posture',
      title: 'Rollback reference is thin',
      severity: 'medium',
      category: 'rollback',
      summary: 'Only one visible deployment revision is available in the current diagnostics view.',
      detail: 'A prior task definition revision may still exist, but the operator does not have strong in-context rollback cues.',
      evidence: [`deployments=${diagnostics.service.deployments.length}`],
      impact: 'Rollback under pressure may rely on manual reconstruction of the previous working revision.',
      inference: true,
      recommendedActionIds: ['ecs-force-deploy-checklist']
    })
  }

  return findings
}

function buildEcsRecommendations(
  region: string,
  diagnostics: EcsServiceDiagnostics,
  findings: ObservabilityFinding[]
): ObservabilityRecommendation[] {
  const serviceName = diagnostics.service.serviceName
  const recommendations: ObservabilityRecommendation[] = [
    {
      id: 'ecs-add-otel-sidecar',
      title: 'Generate an ECS OTel sidecar snippet',
      type: 'json',
      summary: 'Attach telemetry with a task definition snippet instead of forcing a platform install.',
      rationale: 'The MVP focuses on generator output and existing ECS deployment flows.',
      expectedBenefit: 'Provides a reviewable path to traces and richer telemetry without adding backend services.',
      risk: 'Task definition changes require a new revision and rollout validation.',
      rollback: 'Register the prior task definition revision and redeploy it.',
      prerequisiteLevel: 'optional',
      setupEffort: 'low',
      labels: ['Optional setup', 'Generated snippet'],
      artifact: buildArtifact(
        'ecs-otel-sidecar',
        'OTel Sidecar JSON',
        'json-template',
        'json',
        'Task definition fragment for a minimal collector sidecar.',
        makeEcsOtelSidecar(serviceName, region),
        'Review CPU/memory, IAM permissions, and exporter destination before use.'
      )
    },
    {
      id: 'ecs-add-awslogs',
      title: 'Backfill awslogs configuration',
      type: 'json',
      summary: 'Ensure every container can emit baseline stdout/stderr logs to CloudWatch.',
      rationale: 'CloudWatch logs are already part of existing ECS diagnostics flows.',
      expectedBenefit: 'Improves root-cause analysis for non-zero exits and repeated failures.',
      risk: 'Log volume and retention costs can rise.',
      rollback: 'Register a task definition revision without the awslogs block if needed.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install'],
      artifact: buildArtifact(
        'ecs-awslogs',
        'awslogs Config Snippet',
        'json-template',
        'json',
        'Container definition fragment for CloudWatch Logs.',
        makeAwsLogsConfig(serviceName, region),
        'Set a matching log group retention policy to avoid indefinite retention.'
      )
    },
    {
      id: 'ecs-force-deploy-checklist',
      title: 'Use a bounded operator checklist before force deployment',
      type: 'command',
      summary: 'Validate logs, desired count, and prior revision context before forcing rollout.',
      rationale: 'Force deployment is already supported in the app, so the lab should make it safer rather than inventing a new executor.',
      expectedBenefit: 'Reduces accidental redeploys that hide the original failure signal.',
      risk: 'Still restarts tasks if executed without root-cause context.',
      rollback: 'Redeploy the last known good task definition revision or restore desired count.',
      prerequisiteLevel: 'none',
      setupEffort: 'none',
      labels: ['No extra install'],
      artifact: buildArtifact(
        'ecs-force-deploy-command',
        'Force Deployment Command',
        'shell-command',
        'bash',
        'Copyable CLI equivalent for the existing UI action.',
        `aws ecs update-service --cluster "${diagnostics.service.clusterArn}" --service "${serviceName}" --force-new-deployment`,
        'Use only after checking logs/events and confirming blast radius.'
      )
    }
  ]

  if (findings.some((item) => item.id === 'ecs-running-gap')) {
    recommendations.push({
      id: 'ecs-scale-review',
      title: 'Review desired count and capacity assumptions',
      type: 'manual-check',
      summary: 'Under-capacity services need a scale or placement review before experiments.',
      rationale: 'Resilience testing against an already degraded service produces noisy results.',
      expectedBenefit: 'Improves baseline health before applying observability changes or drills.',
      risk: 'Temporary scale-out may increase spend.',
      rollback: 'Return desired count to the pre-validation value.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install']
    })
  }

  return recommendations
}

function buildEcsExperiments(serviceName: string): ResilienceExperimentSuggestion[] {
  return [
    {
      id: 'ecs-stop-task',
      title: 'Single Task Stop Drill',
      summary: 'Stop one task and confirm service recovery plus alarm visibility.',
      hypothesis: 'The ECS scheduler should replace the task quickly and the operator should see clear signals.',
      blastRadius: 'One task in one service.',
      prerequisites: ['Desired count greater than zero', 'Alarm or dashboard prepared'],
      rollback: 'Force deployment or manually increase desired count if recovery stalls.',
      setupEffort: 'none',
      prerequisiteLevel: 'none',
      artifact: buildArtifact(
        'ecs-stop-task-json',
        'FIS Stop Task Template',
        'json-template',
        'json',
        'FIS starter template for a bounded task-stop experiment.',
        makeFisJson(serviceName),
        'Optional enhancement; requires AWS FIS permissions and careful target review.'
      )
    }
  ]
}

export async function generateTerraformObservabilityReport(
  profileName: string,
  projectId: string,
  connection: AwsConnection
): Promise<ObservabilityPostureReport> {
  const project = await getProject(profileName, projectId)
  let drift: TerraformDriftReport | null = null
  try {
    drift = await getTerraformDriftReport(profileName, projectId, connection)
  } catch (error) {
    logWarn('observability-lab.drift-fetch', 'Failed to fetch Terraform drift report for observability lab.', { projectId }, error)
    drift = null
  }

  const findings = buildTerraformFindings(project, drift)
  const recommendations = buildTerraformRecommendations(project)
  const experiments = buildTerraformExperiments(project.name)
  const artifacts = pushRecommendationArtifacts(recommendations, experiments)

  return sortReport({
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'terraform',
      connection: connectionRef(connection),
      projectId,
      projectName: project.name,
      rootPath: project.rootPath
    },
    summary: buildSummary([
      {
        id: 'logs',
        label: 'Logs',
        ok: project.inventory.filter((item) => item.type === 'aws_cloudwatch_log_group').length,
        total: Math.max(project.inventory.length, 1),
        goodDetail: 'CloudWatch log groups exist in the workspace inventory.',
        weakDetail: 'Workspace-level heuristic: log group resources are sparse or absent.'
      },
      {
        id: 'metrics',
        label: 'Metrics',
        ok: project.inventory.filter((item) => item.type === 'aws_cloudwatch_metric_alarm').length,
        total: Math.max(project.inventory.length, 1),
        goodDetail: 'Alarm resources are present in the workspace.',
        weakDetail: 'Workspace-level heuristic: alarm resources are sparse or absent.'
      },
      {
        id: 'traces',
        label: 'Trace Readiness',
        ok: project.inventory.filter((item) => /otel|xray/i.test(item.address)).length,
        total: Math.max(project.inventory.length, 1),
        goodDetail: 'Telemetry-related resources are visible in Terraform inventory.',
        weakDetail: 'Workspace-level heuristic: no obvious OTel/X-Ray resources are visible.'
      },
      {
        id: 'deployment',
        label: 'Deployment Resilience',
        ok: project.planChanges.filter((item) => item.actionLabel === 'no-op').length,
        total: Math.max(project.planChanges.length, 1),
        goodDetail: 'Current plan appears relatively stable.',
        weakDetail: 'Plan or inventory suggests active change pressure; validate before resilience work.'
      },
      {
        id: 'rollback',
        label: 'Rollback Readiness',
        ok: drift ? drift.items.filter((item) => item.status === 'in_sync').length : 0,
        total: Math.max(drift?.items.length ?? 1, 1),
        goodDetail: 'Most drift-checked resources appear in sync.',
        weakDetail: 'Drift is present or drift data is unavailable from the current context.'
      }
    ]),
    findings,
    recommendations,
    experiments,
    artifacts,
    safetyNotes: [
      {
        title: 'Snippet preview first',
        blastRadius: 'The lab only generates HCL snippets and JSON templates.',
        prerequisites: ['Review module boundaries and naming before adding snippets'],
        rollback: 'Remove the snippet from your workspace and re-run plan.'
      },
      {
        title: 'Heuristic Terraform analysis',
        blastRadius: 'Findings are best-effort and based on current inventory/state visibility.',
        prerequisites: ['Run plan/drift in the existing workspace when you need stronger confidence'],
        rollback: 'No runtime change occurs unless you choose to commit/apply generated code.'
      }
    ],
    correlatedSignals: [
      {
        id: 'terraform-drift',
        title: 'Terraform drift',
        detail: 'Use the existing drift tab to validate whether observability/resilience gaps also appear as drift.',
        serviceId: 'terraform',
        targetView: 'drift'
      },
      {
        id: 'cloudwatch',
        title: 'CloudWatch',
        detail: 'Generated alarm/log snippets are intended to map into existing CloudWatch views.',
        serviceId: 'cloudwatch',
        targetView: 'overview'
      }
    ]
  })
}

function buildTerraformFindings(project: TerraformProject, drift: TerraformDriftReport | null): ObservabilityFinding[] {
  const findings: ObservabilityFinding[] = []
  const alarmCount = project.inventory.filter((item) => item.type === 'aws_cloudwatch_metric_alarm').length
  const logGroupCount = project.inventory.filter((item) => item.type === 'aws_cloudwatch_log_group').length
  const telemetryResources = project.inventory.filter((item) => /otel|xray/i.test(item.address))

  if (alarmCount === 0) {
    findings.push({
      id: 'tf-no-alarms',
      title: 'No CloudWatch alarms are visible in the workspace',
      severity: 'medium',
      category: 'metrics',
      summary: 'Workspace-level heuristic: monitoring alarms may be missing.',
      detail: 'This is a heuristic based on Terraform inventory, not a full account-wide truth.',
      evidence: ['No aws_cloudwatch_metric_alarm resources in inventory'],
      impact: 'Rollback and resilience experiments may lack fast operator feedback.',
      inference: true,
      recommendedActionIds: ['tf-add-alarm']
    })
  }

  if (logGroupCount === 0) {
    findings.push({
      id: 'tf-log-retention',
      title: 'Log group management is not obvious in Terraform inventory',
      severity: 'medium',
      category: 'logs',
      summary: 'Workspace-level heuristic: log retention may be unmanaged or defaulting indefinitely.',
      detail: 'Some services auto-create log groups outside Terraform. The workspace currently does not show many managed log groups.',
      evidence: ['No aws_cloudwatch_log_group resources in inventory'],
      impact: 'Operators may inherit inconsistent retention and discovery behavior.',
      inference: true,
      recommendedActionIds: ['tf-add-log-retention']
    })
  }

  if (telemetryResources.length === 0) {
    findings.push({
      id: 'tf-trace-heuristic',
      title: 'No obvious telemetry resources are visible',
      severity: 'low',
      category: 'traces',
      summary: 'Workspace-level heuristic: OTel/X-Ray resources are not obvious.',
      detail: 'This inference is based on resource addresses only and should be verified against modules and application code.',
      evidence: ['No resource address matched otel/xray patterns'],
      impact: 'Trace readiness may be underdefined in infrastructure-as-code.',
      inference: true,
      recommendedActionIds: ['tf-add-otel-support']
    })
  }

  if (drift && drift.summary.statusCounts.drifted > 0) {
    findings.push({
      id: 'tf-drift-present',
      title: 'Drift exists in the current workspace',
      severity: 'high',
      category: 'rollback',
      summary: 'Live AWS differs from Terraform state for at least some resources.',
      detail: 'Observability and resilience changes should be layered onto a known baseline, not on top of unresolved drift.',
      evidence: [`drifted=${drift.summary.statusCounts.drifted}`, `missing_in_aws=${drift.summary.statusCounts.missing_in_aws}`],
      impact: 'Rollback confidence drops when state and reality already diverge.',
      inference: false,
      recommendedActionIds: ['tf-review-drift']
    })
  }

  return findings
}

function buildTerraformRecommendations(project: TerraformProject): ObservabilityRecommendation[] {
  return [
    {
      id: 'tf-add-alarm',
      title: 'Generate a baseline CloudWatch alarm resource',
      type: 'terraform',
      summary: 'Start with a reusable CPU alarm snippet and adapt the metric namespace/dimensions.',
      rationale: 'Alarm resources are the lowest-friction resilience signal inside Terraform-managed workflows.',
      expectedBenefit: 'Adds operator-visible failure thresholds to existing CloudWatch flows.',
      risk: 'Poorly tuned thresholds can create noise.',
      rollback: 'Remove the resource block and re-run plan/apply.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install'],
      artifact: buildArtifact(
        'tf-alarm-snippet',
        'CloudWatch Alarm Snippet',
        'terraform-snippet',
        'hcl',
        'Baseline alarm resource for service CPU pressure.',
        makeTerraformAlarmSnippet(project.name),
        'Adjust namespace, dimensions, and threshold before use.'
      )
    },
    {
      id: 'tf-add-log-retention',
      title: 'Manage log retention explicitly in Terraform',
      type: 'terraform',
      summary: 'Generate a log group resource with explicit retention.',
      rationale: 'Retention is often forgotten when log groups are auto-created by services.',
      expectedBenefit: 'Makes cost and retention posture reviewable in code.',
      risk: 'Taking ownership of an existing log group can require import/state work.',
      rollback: 'Remove the block or import strategy and re-run plan.',
      prerequisiteLevel: 'none',
      setupEffort: 'low',
      labels: ['No extra install'],
      artifact: buildArtifact(
        'tf-log-snippet',
        'Log Retention Snippet',
        'terraform-snippet',
        'hcl',
        'Starter HCL for explicit CloudWatch Logs retention.',
        makeTerraformLogRetentionSnippet(project.name),
        'Verify whether the log group already exists before applying.'
      )
    },
    {
      id: 'tf-add-otel-support',
      title: 'Model telemetry support as code before rollout',
      type: 'terraform',
      summary: 'Keep telemetry infra changes reviewable as snippets, not auto-applied mutations.',
      rationale: 'The MVP is an operator assistant and generator, not an install platform.',
      expectedBenefit: 'Makes future OTel or supporting IAM/log resources easier to review.',
      risk: 'Snippet still needs module-specific adaptation.',
      rollback: 'Remove the snippet and re-plan.',
      prerequisiteLevel: 'optional',
      setupEffort: 'medium',
      labels: ['Optional setup']
    },
    {
      id: 'tf-review-drift',
      title: 'Resolve drift before resilience changes',
      type: 'manual-check',
      summary: 'Use the existing drift view to re-establish a trustworthy baseline.',
      rationale: 'Resilience experiments on top of unresolved drift are harder to interpret.',
      expectedBenefit: 'Improves confidence in generated Terraform changes and rollback paths.',
      risk: 'Drift remediation can surface additional infrastructure changes.',
      rollback: 'Revert the remediation plan or restore expected state definitions.',
      prerequisiteLevel: 'none',
      setupEffort: 'medium',
      labels: ['No extra install']
    }
  ]
}

function buildTerraformExperiments(projectName: string): ResilienceExperimentSuggestion[] {
  return [
    {
      id: 'tf-fis-resource',
      title: 'Generate an AWS FIS Terraform resource',
      summary: 'Model a bounded experiment template in Terraform before running it.',
      hypothesis: 'Failure injection should be codified and reviewed like any other infra change.',
      blastRadius: 'Defined by your final target/resource selection.',
      prerequisites: ['AWS FIS IAM role', 'Explicit target and stop condition review'],
      rollback: 'Remove the template resource and re-run plan/apply if not needed.',
      setupEffort: 'medium',
      prerequisiteLevel: 'optional',
      artifact: buildArtifact(
        'tf-fis-snippet',
        'FIS Experiment Template Snippet',
        'terraform-snippet',
        'hcl',
        'Starter HCL for an experiment template resource.',
        `resource "aws_fis_experiment_template" "service_resilience" {
  description = "Resilience experiment for ${projectName}"
  role_arn    = "arn:aws:iam::<account-id>:role/AWSFISExperimentRole"

  stop_condition {
    source = "none"
  }
}`,
        'Optional enhancement. Add real targets/actions before planning.'
      )
    }
  ]
}

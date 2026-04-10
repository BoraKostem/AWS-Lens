# Observability And Resilience Lab

## Purpose

The Observability and Resilience Lab is a beta operator-assistant surface inside InfraLens. It analyzes the currently selected AWS or Terraform scope and generates a structured posture report with:

- summary cards across logs, metrics, traces, deployment resilience, and rollback readiness
- prioritized findings with evidence and impact statements
- recommended actions with rationale, risk, rollback notes, and setup effort
- generated artifacts such as YAML, shell commands, JSON templates, and Terraform snippets
- bounded resilience experiment suggestions
- linked follow-up signals back into existing consoles

The lab is not an auto-remediation engine. Its current job is to inspect, infer, and generate reviewable operator artifacts.

## Supported Scopes

The lab currently supports three scopes:

- `EKS` cluster analysis
- `ECS` service analysis
- `Terraform` workspace analysis

These are modeled explicitly in the shared report type as `ObservabilityLabScope` with three variants:

- `eks`
- `ecs`
- `terraform`

Each report also carries a lightweight connection reference containing the active profile, region, label, and session identity context.

## Where It Lives In The Product

The UI surface is shared, but it is embedded into three existing consoles:

- `EKS` side tab: `Resilience Lab`
- `ECS` main tab: `Resilience Lab`
- `Terraform` detail tab: `Lab`

Core implementation files:

- `src/main/aws/observabilityLab.ts`
- `src/shared/types.ts`
- `src/renderer/src/ObservabilityResilienceLab.tsx`
- `src/main/eksIpc.ts`
- `src/main/serviceIpc.ts`
- `src/main/ipc.ts`
- `src/preload/index.ts`

## Report Shape

Every analysis produces an `ObservabilityPostureReport` with these sections:

- `generatedAt`
- `scope`
- `summary`
- `findings`
- `recommendations`
- `experiments`
- `artifacts`
- `safetyNotes`
- `correlatedSignals`

The renderer displays those sections directly in a fixed sequence. Findings are sorted by severity in descending order.

## Analysis Model

The lab uses a generator-first posture:

- collect existing signals from the current console/backend
- derive heuristics where hard proof is not available
- mark inferred findings explicitly with `inference: true`
- generate copyable artifacts instead of silently changing infrastructure

Severity levels:

- `critical`
- `high`
- `medium`
- `low`
- `info`

Finding categories:

- `logs`
- `metrics`
- `traces`
- `deployment`
- `chaos`
- `rollback`

Summary cards are scored using a simple ratio and labeled as:

- `good`
- `mixed`
- `weak`

## Scope-Specific Inputs

### EKS

The EKS report combines:

- `describeEksCluster`
- `listEksNodegroups`
- temporary kubeconfig generation through `createTempEksKubeconfig`
- optional live metrics sampling through `getEksMetricsSnapshot`

The metrics path checks:

- `metrics.k8s.io`
- `kubectl top nodes`
- `kubectl top pods -A`

This means EKS is the only scope that currently tries to sample live runtime usage, and it does so only when kubeconfig generation succeeds and Metrics Server is reachable.

### ECS

The ECS report builds on the existing diagnostics pipeline rather than inventing a second model. It reuses:

- service detail
- deployment history
- running and stopped task rows
- task definition references
- container log targets
- summary tiles and failure indicators

The ECS lab is therefore an overlay on top of the existing ECS diagnostics system, not a separate backend.

### Terraform

The Terraform report combines:

- `getProject`
- optional `getTerraformDriftReport`

It reads current project inventory and plan/drift context, then applies workspace-level heuristics for alarms, log retention, telemetry resources, and rollback confidence.

## EKS Behavior

### EKS Summary Areas

The EKS report scores:

- `Logs`: based on enabled control plane log types
- `Metrics`: based on live metrics availability and node pressure
- `Trace Readiness`: based on presence of OIDC issuer as a proxy for IRSA-friendly telemetry setup
- `Deployment Resilience`: based on whether nodegroups have `max > desired`
- `Rollback Readiness`: based on whether a kubectl session can be prepared

### EKS Findings

The current EKS finding set includes:

- partial control plane logging coverage
- public-only endpoint posture
- insufficient nodegroup surge headroom
- inferred lack of workload-level trace pipeline visibility
- Metrics Server or `metrics.k8s.io` not reachable
- live CPU or memory pressure from `kubectl top`
- failed kubectl session preparation

Important detail: workload-level trace absence is explicitly treated as an inference. The current MVP does not inspect workload manifests to prove whether instrumentation exists.

### EKS Recommendations

The EKS recommendation set can generate:

- an AWS CLI command to enable the full EKS control plane logging set
- a minimal OpenTelemetry collector YAML manifest
- a read-only CLI command to inspect endpoint exposure and public CIDRs
- a read-only `metrics.k8s.io` verification command
- manual guidance to preserve nodegroup headroom when the report detects no surge capacity
- manual guidance to restore kubectl readiness when kubeconfig preparation fails

### EKS Experiments

The EKS experiment suggestions currently include:

- a bounded `kubectl delete pod` drill
- an AWS FIS starter JSON template

These are suggestions only. The analysis flow itself does not mutate the cluster.

### EKS Correlated Signals

The report points back to:

- the EKS change timeline
- CloudTrail

In the current renderer integration, only the EKS timeline signal is wired to an in-console tab switch. The CloudTrail signal is present in the report payload but is not yet routed to a dedicated CloudTrail navigation flow.

## ECS Behavior

### ECS Summary Areas

The ECS report scores:

- `Logs`: ratio of containers with visible `awslogs` targets
- `Metrics`: reuse of existing ECS diagnostics summary tiles related to running/healthy state
- `Trace Readiness`: presence of a container whose name or image matches `otel`, `open-telemetry`, or `xray`
- `Deployment Resilience`: running count versus desired count
- `Rollback Readiness`: whether more than one deployment revision is visible

### ECS Findings

The current ECS finding set includes:

- service under desired count
- repeated stopped task failures
- no visible `awslogs` target
- inferred lack of a telemetry sidecar
- thin rollback reference when only one deployment is visible

Two points matter here:

- repeated failures are grounded in the existing failed task diagnostics, not a new log parser
- trace readiness is inferred from task definition container names and images, not from runtime trace inspection

### ECS Recommendations

The ECS recommendation set can generate:

- an ECS task-definition JSON fragment for an `aws-otel-collector` sidecar
- an ECS `awslogs` configuration snippet
- a copyable AWS CLI `force-new-deployment` command
- a manual desired-count and capacity review recommendation when the service is already under target

The ECS lab deliberately leans on existing operational flows instead of creating a second deployment executor.

### ECS Experiments

The ECS experiment set currently contains one bounded suggestion:

- an AWS FIS stop-task template for a single-task disruption drill

### ECS Correlated Signals

The report links back to:

- ECS diagnostics
- CloudWatch logs

In the current console wiring:

- `services` pivots back to the ECS services tab
- `logs` pivots to the ECS tasks tab

This is a local ECS-console navigation shortcut, not a full cross-console jump into the CloudWatch workspace.

## Terraform Behavior

### Terraform Summary Areas

The Terraform report scores:

- `Logs`: count of `aws_cloudwatch_log_group` resources in workspace inventory
- `Metrics`: count of `aws_cloudwatch_metric_alarm` resources
- `Trace Readiness`: resource addresses matching `otel` or `xray`
- `Deployment Resilience`: current plan changes marked `no-op`
- `Rollback Readiness`: in-sync drift counts when drift data is available

This is intentionally heuristic. It evaluates the current Terraform workspace view, not the entire AWS account.

### Terraform Findings

The current Terraform finding set includes:

- no visible CloudWatch alarms
- log retention not obviously managed in Terraform
- no obvious telemetry resources
- active workspace drift

Three of those are explicitly heuristic:

- missing alarms
- missing log groups
- missing telemetry resources

The drift finding is stronger because it comes from the existing drift report when available.

### Terraform Recommendations

The Terraform recommendation set can generate:

- a baseline CloudWatch alarm HCL snippet
- a CloudWatch log retention HCL snippet
- guidance to model telemetry support as code before rollout
- guidance to resolve drift before resilience changes

### Terraform Experiments

The Terraform experiment set currently contains:

- a starter `aws_fis_experiment_template` HCL snippet

This keeps chaos definitions inside infrastructure-as-code rather than asking the user to build them only in the console.

### Terraform Correlated Signals

The report links back to:

- the Terraform drift view
- CloudWatch

In the current console integration, only the Terraform drift signal is wired to a concrete tab change.

## Generated Artifact Types

The lab can emit these artifact types:

- `yaml`
- `shell-command`
- `terraform-snippet`
- `json-template`
- `otel-collector-config`
- `kubectl-patch`

Current generated examples in the implementation include:

- EKS OTel collector YAML
- EKS logging and endpoint review AWS CLI commands
- EKS Metrics Server verification command
- ECS OTel sidecar JSON
- ECS `awslogs` JSON
- ECS force deployment AWS CLI command
- ECS and EKS FIS starter JSON templates
- Terraform CloudWatch alarm HCL
- Terraform log retention HCL
- Terraform FIS experiment template HCL

## Artifact Execution Model

The shared UI supports:

- copy-to-clipboard for every artifact
- optional run-in-terminal actions for runnable artifacts

However, the current backend always creates artifacts with `isRunnable = false`. So in practice, the lab is copy-first today.

The console shells for ECS and Terraform already provide `onRunArtifact` hooks that send artifact content into the embedded terminal, but no current lab artifact opts into that path.

## Safety Model

The safety posture is intentionally conservative.

What the lab does today:

- reads AWS, Terraform, and diagnostics state
- generates artifacts
- emits explicit safety notes
- calls out rollback expectations in each recommendation

What the lab does not do during report generation:

- apply Kubernetes manifests
- register ECS task definitions
- update ECS services
- change EKS endpoint posture
- enable EKS logging automatically
- mutate Terraform code
- apply Terraform changes
- run AWS FIS experiments

This matches the implementation language throughout the report:

- `preview-only`
- `generated snippet`
- `read-only command`
- `optional enhancement`

## Data Quality And Confidence Model

The lab mixes direct evidence with bounded inference.

Direct evidence examples:

- EKS control plane log configuration
- EKS endpoint public/private access flags
- `metrics.k8s.io` reachability
- ECS running versus desired count
- ECS visible deployments
- Terraform drift status

Inference examples:

- missing workload-level trace pipeline in EKS
- missing trace sidecar in ECS from image/name heuristics
- missing telemetry resources in Terraform based on address matching
- missing monitoring/log-management posture in Terraform inventory

This distinction is important. The report is honest about where it can observe hard facts and where it is surfacing likely gaps from partial visibility.

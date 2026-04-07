# AWS Lens

AWS Lens is a desktop app for people who spend too much of the day bouncing between the AWS Console, Terraform, and a terminal.

It gives you one place to inspect infrastructure, work through changes, compare environments, assume roles, run follow-up commands, and keep moving without losing context every five minutes.

![AWS Lens overview](images/overview.png)

## Why this app exists

AWS work tends to get scattered fast.

You open the AWS Console to inspect a resource. You jump to Terraform to figure out whether it is managed. You open a terminal to run a command. Then you switch accounts, switch regions, lose the thread, and start over.

AWS Lens pulls those steps into one desktop workspace. The point is not to replace AWS or Terraform. The point is to make the day-to-day work less fragmented.

## Why you sould use it

- You want one app that keeps your AWS profile, region, and tooling context together
- You are tired of hopping between browser tabs, local Terraform folders, and shell windows
- You need to inspect infrastructure and then act on it without rebuilding the same context by hand
- You work across multiple accounts and roles and want those switches to feel less clumsy
- You want Terraform work, AWS service views, findings, and follow-up commands to live in the same place

## What you can do with it

### Get a clearer view of an AWS account

AWS Lens gives you service-specific workspaces for the parts of AWS people actually touch every day: EC2, S3, EKS, ECS, Lambda, RDS, networking, IAM, CloudWatch, CloudTrail, Secrets Manager, and more.

Instead of digging through the AWS Console from scratch, you start from a shared account and region context and move through the app from there.

### Keep Terraform close to the infrastructure it changes

Terraform is built into the same workspace, not treated like a separate tool you have to mentally switch into.

You can track projects, work with workspaces and variables, inspect plans, review drift, browse state, and keep command history close to the AWS resources those projects affect.

AWS Lens also includes a Terraform adoption flow for unmanaged resources. From supported service detail screens you can use `Manage in Terraform` to detect whether a resource is already claimed, choose the target Terraform project, review the generated HCL and import plan, and then validate the result after import. When a full guided import is not available, the app falls back to a manual adoption preview with import commands, HCL skeletons, and rollback guidance.

On top of that, the app now includes an overview-level incident timeline and operator guardrails. You can inspect the last `30m`, `1h`, or a custom window, correlate CloudTrail, CloudWatch, Terraform, and drift signals, surface frequent assume-role usage and risky actions, and then drill straight into CloudWatch, CloudTrail, Terraform history, drift detail, related service screens, or the embedded terminal without rebuilding context.

![Terraform workspace](images/terraform-main.png)

### Switch roles without the usual friction

If you work across multiple AWS accounts, Session Hub gives you a cleaner way to manage saved assume-role targets and temporary sessions. You can activate a session, keep using the app in that context, and send commands to the embedded terminal without rebuilding credentials by hand.

### Compare environments side by side

When something looks off in staging, prod, or a separate account, Compare Workspace helps you inspect both contexts together instead of flipping back and forth and hoping you remember what changed.

### Work through findings instead of just collecting them

Compliance Center and related workflows are there for the messy part after you notice a problem: triage, ownership, follow-up, and remediation notes. That matters more than a pretty dashboard.

### Stay in flow with the terminal

There is an embedded terminal in the app, and it follows the active AWS context. That means you can inspect something in the UI and then run the next command without stopping to reconstruct environment variables or switch tools again.

## What makes it different

AWS Lens is not trying to be another generic cloud dashboard.

It is built around a simple idea: AWS work is usually a chain of small actions across different tools, and the friction comes from losing context between those actions. This app tries to keep that chain intact.

## Who it is for

- Platform and infrastructure engineers
- DevOps teams
- People managing Terraform-heavy AWS environments
- Anyone doing recurring account audits, incident follow-up, or cross-account work

## What is in the app

- AWS service workspaces for common day-to-day operations
- A Terraform workspace for project tracking, drift inspection, governance checks, and state workflows
- Cross-service Terraform adoption from AWS resources into tracked Terraform projects, with guided import for EC2 and manual adoption previews for RDS, S3, IAM, Security Groups, Route53, ECS, EKS, Lambda, SQS, SNS, Secrets Manager, and KMS
- An overview-level incident timeline with correlation, guardrails, and context-preserving drill-down into CloudWatch, CloudTrail, Terraform, related service consoles, and terminal handoff
- Session Hub for assume-role targets and temporary sessions
- Compare Workspace for side by side account or region inspection
- Compliance Center for findings and remediation tracking
- Direct Resource Access for cases where you know the resource identifier but cannot list the whole service
- An embedded terminal that follows the active AWS context
- A local encrypted vault for app-managed credentials and other sensitive app state
- Vault workflows for AWS credentials, DB logins, API tokens, kubeconfig fragments, PEM files, and SSH private keys
- Rotation, expiry, reminder, origin, and last-used visibility for local vault entries
- Connection presets for EC2 SSH, EKS kubeconfig, and RDS helper flows
- PEM and SSH key fingerprint inspection with EC2 key pair correlation

## Getting started

```powershell
pnpm install
pnpm dev
```

If you want packaged builds:

```powershell
pnpm dist
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

## Requirements

- Node.js 20 or newer
- `pnpm`
- Local AWS credentials for the accounts you want to use
- Terraform CLI if you want Terraform features

Optional tools:

- `tflint`, `tfsec`, `checkov`
- AWS CLI
- `kubectl`
- `docker`

## Technical notes

This repository is an Electron app with:

- `src/main/` for privileged app logic, AWS integrations, Terraform orchestration, and IPC
- `src/preload/` for the secure renderer bridge
- `src/renderer/` for the React UI
- `src/shared/` for shared types and contracts

The app reads standard AWS workstation files when needed:

- `~/.aws/config`
- `~/.aws/credentials`

It also stores local app state under Electron `userData`, including files such as:

- `local-vault.json`
- `phase1-foundations.json`
- `compare-baselines.json`
- `terraform-workspace-state.json`
- `session-hub.json`
- `profile-registry.json`
- `terraform-state-backups/`

Important behavior:

- app-managed credentials are stored in the encrypted local vault instead of being written back to `~/.aws/credentials`
- imported PEM and SSH keys are encrypted into the local vault instead of depending on a durable plaintext temp copy
- temporary assumed-role credentials stay in memory
- Secrets Manager and manual runtime credentials can be resolved for a session without being silently persisted into the local vault
- mutating actions run through the Electron main process
- the renderer talks to that layer through the preload bridge

## More documentation

The `docs/` directory has more detail if you want the implementation and workflow notes:

- [AWS usage and security](docs/aws-lens-usage.md)
- [Session Hub](docs/session-hub-usage.md)
- [Terraform workspace management](docs/terraform-workspace-management.md)
- [Terraform drift reconciliation](docs/terraform-drift-reconciliation.md)
- [Terraform state operations center](docs/terraform-state-operations-center.md)
- [Observability and resilience lab](docs/observability-and-resilience-lab.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

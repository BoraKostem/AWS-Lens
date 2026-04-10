# InfraLens Usage and Security

This guide documents the enterprise-oriented operating model for InfraLens.

## Installation and first run

InfraLens starts with a shared account-and-region shell:

- Import profiles from existing AWS config and credentials files when you need to reuse workstation state.
- App-created credentials are stored in the local encrypted vault instead of being written back to `~/.aws/credentials`.
- Region selection is global inside the shell. Service workspaces inherit the currently selected region unless a flow explicitly changes it.
- Pinned profiles stay in the rail so operators can switch context without rebuilding the entire navigation model.

## Permission model

InfraLens now distinguishes between two runtime access modes:

- `read-only`
  - Intended for users who should inspect resources, review posture, or gather context.
  - Mutating AWS operations are blocked.
  - Command-execution flows are blocked. This includes embedded command runners and other workflows that can change infrastructure or account state.
- `operator`
  - Intended for users who are allowed to create, update, delete, rotate, attach, detach, or otherwise change AWS-managed resources.
  - Critical command-execution flows are enabled.
  - Audit export is available so actions can be reviewed outside the app.

The access mode is stored locally in secure app state and applies across the entire InfraLens shell.

## AWS credential model

InfraLens supports two credential sources:

- External AWS config / credentials files
  - Existing workstation files continue to load as-is.
  - The app does not silently rewrite imported credentials.
- App-managed credentials
  - Credentials created or saved inside InfraLens are written to the encrypted local vault.
  - This keeps app-created access keys out of plaintext credential files.

Temporary access is handled through Session Hub:

- saved assume-role targets define repeatable cross-account entry points
- active assumed-role sessions carry the current region and source profile context
- the shell exposes the resulting context to service workspaces

## Terraform workspace model

Terraform support is treated as a first-class operational surface:

- project metadata and workspace state are stored in secure local persistence
- workspace selection and project context remain tied to the active AWS profile
- read-only mode is intended for plan review and inspection workflows
- operator mode is required for mutating Terraform commands such as `apply`, `destroy`, `import`, `state mv`, `state rm`, and `force-unlock`

This keeps Terraform command execution aligned with the same operator boundary used for direct AWS resource mutations.

## Security boundaries

InfraLens is a local desktop control plane, not a managed SaaS boundary. The current security model is:

- local secure storage for enterprise settings and audit trail
- local secure storage for app-created credentials and sensitive workspace metadata
- read-only enforcement for critical mutating flows at the app IPC boundary
- in-app service maturity labels so production-ready, beta, and experimental surfaces are visibly distinct

Current non-goals:

- central multi-user policy enforcement
- remote audit collection
- server-side approval workflows

Those should be handled by the surrounding enterprise environment if required.

## Audit trail

Critical operator actions and read-only blocks are written to the local enterprise audit log. Each event captures:

- timestamp
- action and IPC channel
- current access mode
- actor/session label when available
- AWS account and region when available
- resource identifier when one can be inferred
- outcome: `success`, `blocked`, or `failed`

The audit log can be exported as JSON for external review or retention.

# Terraform Workspace Management

## Purpose

This document explains how InfraLens manages Terraform workspaces for a tracked project, where workspace state is stored, and what safeguards apply when an operator creates, switches, or deletes a workspace.

It focuses on the current Electron implementation in this repository, not generic Terraform usage.

## What InfraLens Treats As Workspace State

InfraLens tracks workspace information in two places:

- Terraform-native files inside the project directory
- app-managed metadata under Electron `userData`

### Inside The Terraform Project

Terraform itself remains the source of truth for the active workspace and workspace-specific state layout.

InfraLens reads or writes these project-local locations:

- `.terraform/environment`
  - current workspace name
- `terraform.tfstate`
  - default local-backend state file
- `terraform.tfstate.d/<workspace>/terraform.tfstate`
  - local backend workspace state files when Terraform creates them
- `.terraform-workspace.auto.tfvars.json`
  - app-managed inputs written before commands that need them
- `.terraform-workspace.tfplan`
- `.terraform-workspace.tfplan.meta.json`
- `.terraform-workspace.state.json`
  - cached result of state reads and pulls

### Inside Electron userData

InfraLens persists project registration and workspace-related UI metadata in:

- `terraform-workspace-state.json`

That file stores data per AWS profile. For each tracked project it keeps:

- project ID
- project name
- root path
- selected input configuration
- persisted variable values
- environment metadata such as:
  - `workspaceName`
  - `environmentLabel`
  - `region`
  - `connectionLabel`
  - `backendType`
  - `varSetLabel`

This app-level file does not replace Terraform's own workspace state. It exists so the UI can restore project context quickly.

## How InfraLens Detects Workspaces

When a project is loaded, InfraLens first tries the Terraform CLI:

```text
terraform workspace show
terraform workspace list
```

If those commands succeed, the UI uses their output as the workspace snapshot.

If they fail, InfraLens falls back to a filesystem-based snapshot:

1. read `.terraform/environment` for the current workspace
2. scan `terraform.tfstate.d/` for known workspace directories
3. always include `default`

That fallback lets the UI remain usable even when the CLI is unavailable, not initialized, or temporarily failing.

## Workspace Operations

All workspace mutations run in the Electron main process and invoke Terraform directly against the tracked project root.

### Select Workspace

InfraLens runs:

```text
terraform workspace select <name>
```

After a successful switch, InfraLens:

- clears the cached state snapshot
- refreshes the project detail
- updates the stored environment metadata in `terraform-workspace-state.json`

### Create Workspace

InfraLens runs:

```text
terraform workspace new <name>
```

Terraform creates the workspace and switches into it. After success, InfraLens clears cached state and reloads the project view.

### Delete Workspace

InfraLens runs:

```text
terraform workspace delete <name>
```

Before it allows that action, InfraLens enforces these rules:

- workspace name must be non-empty
- workspace name cannot contain whitespace
- `default` cannot be deleted
- the currently selected workspace cannot be deleted
- the UI requires typed confirmation for the chosen workspace name

Terraform remains the final authority. If the backend refuses deletion, InfraLens surfaces the Terraform error instead of forcing the change.

## Backend And State Implications

Workspace handling affects where Terraform state lives and how InfraLens labels backend details.

### Local Backend

For local state, InfraLens treats:

- `terraform.tfstate` as the default workspace state file
- `terraform.tfstate.d/<workspace>/terraform.tfstate` as the non-default workspace location

When the app needs to display a current state snapshot, it resolves sources in this order:

1. `terraform.tfstate`
2. newest readable workspace state file under `terraform.tfstate.d/*/terraform.tfstate`
3. cached `terraform state pull` output
4. no state

### S3 Backend

For S3 backends, InfraLens parses backend settings from Terraform files and computes the effective state key for the active workspace.

Behavior:

- `default` uses the configured backend `key`
- non-default workspaces use:

```text
<workspace_key_prefix>/<workspace>/<key>
```

If `workspace_key_prefix` is not set, InfraLens assumes Terraform's common default of `env:`.

That computed path is used in backend labels shown in the UI so operators can tell which remote state object is active for the selected workspace.

## Inputs And Workspace Changes

Workspace selection is separate from variable-set selection, but InfraLens keeps both in the project environment summary.

Commands such as `plan`, `apply`, `destroy`, `import`, and selected state commands can cause InfraLens to write runtime input files before invoking Terraform. That means:

- switching workspaces changes the Terraform state target
- selected variable sets still control the input values passed into Terraform
- the two concepts are related in the UI but stored independently

InfraLens does not automatically map a workspace name to a variable overlay. Operators can use matching names if they want that convention, but it is not enforced by the app.

## UI Safeguards

The Terraform console exposes workspace controls directly in the project view:

- a selector for the current workspace
- a `Create Workspace` action
- a `Delete Workspace` action

Current safeguards in the renderer:

- delete options only list non-current, non-`default` workspaces
- create trims surrounding whitespace before submission
- delete requires the operator to type the exact workspace name
- running Terraform commands disable workspace-changing controls

The main process repeats the critical safety checks, so the protection does not rely only on the renderer.

## Operational Guidance

- Use `default` for the baseline state only if the Terraform project is intentionally designed that way.
- Prefer explicit workspace names such as `dev`, `staging`, or `prod` instead of overloading one workspace with variable-file changes.
- Do not treat `terraform-workspace-state.json` as canonical infrastructure state; it is UI persistence only.
- If workspace detection looks wrong, inspect `.terraform/environment` and `terraform.tfstate.d/` first.
- If a delete fails, assume the backend or Terraform CLI is protecting state and resolve that in Terraform rather than editing app files manually.
- After a workspace switch, re-check the backend label and current state source before destructive operations.

## Related Docs

- `docs/terraform-state-operations-center.md`
- `docs/terraform-drift-reconciliation.md`

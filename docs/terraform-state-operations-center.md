# Terraform State Operations Center

## Purpose

The State Operations Center is the guided UI for Terraform state changes inside InfraLens. It is intended for cases where an operator needs to:

- import an existing remote object into Terraform state
- move a state address during a refactor
- remove an address from Terraform state without deleting the real cloud resource
- inspect lock metadata and force-unlock a stuck state lock

All state actions run in the Electron main process instead of asking the operator to type raw Terraform CLI commands manually.

## What The Screen Shows

The top summary cards expose the current state snapshot and backup status for the selected project:

- `Current state source`: where InfraLens read the current state snapshot from
- `Latest backup`: the newest locally captured backup, if one exists
- `Backup inventory`: how many project-scoped backups are currently retained

The page then exposes four guided workflows:

- `Import Resource`
- `Move State Address`
- `Remove From State`
- `Force Unlock`

It also shows recent backups and the current lock inspection result.

## Current State Source

InfraLens resolves the displayed state snapshot in this order:

1. `terraform.tfstate` in the project root
2. the newest workspace file under `terraform.tfstate.d/<workspace>/terraform.tfstate`
3. the cached result of `terraform state pull`
4. no state (`none`)

That produces these state source labels:

- `local`
- `workspace:<name>`
- `remote-cache`
- `none`

For remote backends, `remote-cache` means InfraLens is showing the most recently cached result of `terraform state pull`.

## Backups

Destructive state operations create a local backup before Terraform is invoked.

### When A Backup Is Created

Backups are created before:

- `state mv`
- `state rm`
- `force-unlock`

Import does not create a backup.

### How Backup Capture Works

Backup creation attempts to capture the best available snapshot in this order:

1. run `terraform state pull`
2. if that fails, fall back to the currently readable state snapshot

If no readable state exists at all, the operation is blocked with an error rather than proceeding without a backup.

### Where Backups Are Stored

Backups are written under the Electron `userData` directory:

`terraform-state-backups/<projectId>`

Each file is named with the capture timestamp and source, for example:

```text
2026-03-29T19-22-10-123Z.remote-pull.tfstate.backup.json
```

### Retention

InfraLens keeps the 20 newest backups per project and deletes older ones automatically.

## Guided Operations

### Import Resource

Use this when the remote object already exists and Terraform should start managing it.

Inputs:

- Terraform address, for example `aws_s3_bucket.logs`
- provider import ID, for example `my-existing-bucket`

InfraLens runs:

```text
terraform import -input=false -no-color <address> <import-id>
```

Behavior notes:

- runtime inputs are resolved before the command runs
- on success, InfraLens refreshes the remote state cache
- on success, saved plan artifacts are cleared because state changed

### Move State Address

Use this during renames, module moves, or refactors where the underlying object is the same but the Terraform address changes.

Inputs:

- source address
- destination address

InfraLens runs:

```text
terraform state mv -lock=true <from> <to>
```

Behavior notes:

- requires typed confirmation in the UI
- always creates a backup first
- refreshes the remote state cache after a successful move
- clears saved plan artifacts after success
- invalidates cached drift results after success

### Remove From State

Use this when Terraform should forget a resource without deleting the real provider-side object.

Input:

- state address to forget

InfraLens runs:

```text
terraform state rm -lock=true <address>
```

Behavior notes:

- requires typed confirmation in the UI
- always creates a backup first
- refreshes the remote state cache after success when possible
- if refresh fails, InfraLens clears the local cache for `state rm` rather than showing stale removed entries
- clears saved plan artifacts after success
- invalidates cached drift results after success

## Lock Status And Force Unlock

### What Lock Inspection Can Show

InfraLens reads lock metadata from these local files when Terraform leaves them behind:

- `.terraform.tfstate.lock.info`
- `.terraform/terraform.tfstate.lock.info`

When available, the UI shows:

- lock ID
- operation
- who created the lock
- created timestamp
- backend type
- info file path

### Important Limitation

Lock inspection is limited to cases where Terraform wrote a local lock info file. For remote backends, the UI may show only limited information even if the backend is actually locked.

### Force Unlock

Use this only when no active Terraform process still owns the lock.

Input:

- lock ID

InfraLens runs:

```text
terraform force-unlock -force <lock-id>
```

Behavior notes:

- requires typed confirmation in the UI
- always creates a backup first
- refreshes the remote state cache after a successful unlock

## Refresh State

The `Refresh State` button reloads the project view so the UI re-reads:

- current state snapshot
- state addresses and inventory
- backup inventory
- latest backup metadata
- lock inspection details

This is a UI reload of Terraform state data. It is not the same as `terraform apply -refresh-only`.

## Inputs And Temporary Files

State operations may still need runtime input values. To support that safely, InfraLens can write a temporary `terraform.tfvars.json` in the project root before state commands run.

If a `terraform.tfvars.json` already exists:

- InfraLens copies it to `terraform.tfvars.json.infra-lens-backup`
- writes the temporary merged values needed for the operation
- restores the original file after the command completes

If no file existed, InfraLens deletes the temporary file after completion.

## Operational Guidance

- Use `Import Resource` when the real object exists and you want Terraform to adopt it.
- Use `Move State Address` for refactors where ownership stays the same and only the address changes.
- Use `Remove From State` when Terraform should stop managing an object but the object must remain in AWS.
- Use `Force Unlock` only after confirming no running Terraform process is still active.
- Check `Latest backup` before destructive state work and keep especially important backups externally if you need long-term retention beyond the built-in limit of 20.

## Audit And Follow-Up

Each state operation is also recorded in Terraform run history with:

- command name
- redacted arguments
- workspace
- region and connection label
- resulting state source
- backup path and backup creation time, when applicable
- state operation summary

That makes the State Operations Center usable as both an operator workflow and a lightweight audit trail for state changes.

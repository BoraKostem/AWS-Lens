# AWS Lens

AWS Lens is an Electron desktop app for AWS operations. It combines a React renderer, Electron main-process IPC handlers, AWS SDK v3 clients, an embedded terminal powered by `node-pty`, and a Terraform workspace for running local Terraform workflows alongside AWS inspection and actions.

## What It Does

- Loads AWS CLI profiles from local config and credentials files
- Lets you select a profile and region from a catalog-oriented shell
- Exposes service consoles for AWS inventory, details, and selected mutations
- Opens an embedded terminal with `AWS_PROFILE`, `AWS_REGION`, and `AWS_DEFAULT_REGION` aligned to the active connection
- Includes a Terraform workspace for managing local Terraform project folders and running CLI commands
- Packages as a desktop app with `electron-builder`

## Current Stack

- Electron
- React 18
- TypeScript
- `electron-vite`
- `electron-builder`
- AWS SDK for JavaScript v3
- `node-pty`
- `xterm`

## Project Layout

```text
.
|-- assets/
|-- src/
|   |-- main/        # Electron main process, AWS clients, IPC handlers, terminal, Terraform orchestration
|   |-- preload/     # contextBridge API exposed to the renderer
|   |-- renderer/    # React UI and service consoles
|   `-- shared/      # shared TypeScript types
|-- electron.vite.config.ts
|-- electron-builder.yml
|-- package.json
`-- tsconfig.json
```

Key areas:

- `src/main/main.ts`: creates the BrowserWindow and registers IPC handlers
- `src/main/aws/`: AWS SDK client creation and per-service data/action modules
- `src/main/*Ipc.ts`: Electron IPC entry points for renderer requests
- `src/main/terminalIpc.ts`: embedded terminal session management via `node-pty`
- `src/main/terraform.ts`: Terraform project discovery, command execution, and state handling
- `src/preload/index.ts`: safe renderer bridge
- `src/renderer/src/App.tsx`: top-level shell, profile catalog, service routing, and terminal toggle
- `src/shared/types.ts`: shared contracts between main, preload, and renderer

## Implemented App Areas

The renderer currently wires these service or workspace screens:

- Terraform
- Overview
- EC2
- CloudWatch
- S3
- Lambda
- Auto Scaling
- RDS
- CloudFormation
- CloudTrail
- ECR
- EKS
- ECS
- VPC
- Load Balancers
- Route 53
- Security Groups
- ACM
- IAM
- Identity Center
- SNS
- SQS
- Secrets Manager
- Key Pairs
- STS
- KMS
- WAF

## Local State

The app reads AWS configuration from the standard local AWS files and also stores app-specific data under Electron user data.

- AWS profiles: `~/.aws/config` and `~/.aws/credentials`
- Terraform workspace state: Electron `userData` as `terraform-workspace-state.json`

Depending on the service flow, local command-line tools may also be used if they are installed:

- AWS CLI
- Terraform CLI
- `kubectl`
- `docker`

## Prerequisites

- Node.js 20+ recommended
- `pnpm`
- Valid local AWS credentials for the profiles you want to use

Optional:

- Terraform CLI for the Terraform workspace
- AWS CLI for local verification outside the app
- `kubectl` for EKS-related terminal workflows
- `docker` for ECR workflows

## Install

```powershell
pnpm install
```

## Run In Development

```powershell
pnpm dev
```

This starts the Electron app through `electron-vite`.

## Typecheck

```powershell
pnpm typecheck
```

## Production Build

```powershell
pnpm build
```

Build output is written to `out/`.

## Package Desktop Builds

```powershell
pnpm dist
```

Platform-specific packaging commands:

```powershell
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

Packaged artifacts are written to `release/`.

## Development Notes

- Renderer code should talk to Electron through the preload bridge instead of reaching into Node APIs directly.
- AWS service actions are implemented in the main process and exposed through focused IPC handlers.
- The embedded terminal is a shared PTY session whose AWS context is updated when the active profile or region changes.
- Terraform support is local-workspace oriented and depends on the host having the Terraform CLI available.
- Packaging unpacks `node-pty` from ASAR so the terminal works in packaged builds.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the expected workflow, testing expectations, and documentation rules.

## License

MIT. See [LICENSE](./LICENSE).

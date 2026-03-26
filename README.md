<div align="center">

# AWS Lens

**Desktop companion for working across multiple AWS accounts and regions, designed to speed up debugging and common quick actions by turning multi-step console tasks into simpler flows and grouping related services into a more informative interface, not to replace the AWS Console.**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue.svg)](#package-desktop-builds)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-blue.svg)](#package-desktop-builds)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-blue.svg)](#package-desktop-builds)
[![Electron](https://img.shields.io/badge/Electron-latest-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB.svg?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![AWS SDK](https://img.shields.io/badge/AWS_SDK-v3-FF9900.svg?logo=amazon-aws&logoColor=white)](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
[![Terraform](https://img.shields.io/badge/Terraform-workspace-7B42BC.svg?logo=terraform&logoColor=white)](https://www.terraform.io/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-package_manager-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io/)

---

<img src="images/overview.png" alt="AWS Lens Overview" width="100%" />

</div>

---

## What It Does

- Loads AWS CLI profiles from local config and credentials files
- Lets you select a profile and region from a catalog-oriented shell
- Exposes service consoles for AWS inventory, details, and selected mutations
- Opens an embedded terminal with `AWS_PROFILE`, `AWS_REGION`, and `AWS_DEFAULT_REGION` aligned to the active connection
- Includes a Terraform workspace for managing local Terraform project folders, running CLI commands, and inspecting Terraform drift against live AWS inventory
- Packages as a desktop app with `electron-builder`

## Extended Features

### Multi-Profile & Multi-Region Management
Switch between AWS CLI profiles and regions instantly. The app reads your local `~/.aws/config` and `~/.aws/credentials`, so there is nothing extra to configure. Every service console and the embedded terminal stay in sync with the active connection.

### 25+ AWS Service Consoles
Browse, inspect, and act on resources across a wide range of AWS services — from compute (EC2, Lambda, ECS, EKS) and storage (S3, ECR) to networking (VPC, Route 53, Load Balancers, Security Groups), security (IAM, Identity Center, ACM, WAF, KMS, Secrets Manager), messaging (SNS, SQS), databases (RDS), monitoring (CloudWatch, CloudTrail), and infrastructure (CloudFormation, Auto Scaling, STS, Key Pairs).

### Embedded Terminal
A fully integrated terminal powered by `node-pty` and `xterm.js`. The terminal session automatically inherits `AWS_PROFILE`, `AWS_REGION`, and `AWS_DEFAULT_REGION` from your current selection, so AWS CLI, `kubectl`, `docker`, and other tools just work without manual env setup.

### Terraform Workspace
The Terraform workspace now also includes operator-focused Drift Intelligence. It compares Terraform-managed inventory with live AWS inventory, highlights `in_sync`, `drifted`, `missing_in_aws`, `unmanaged_in_aws`, and `unsupported` items, and provides AWS console plus `terraform state show` shortcuts from the drift view.

Terraform Drift Intelligence currently provides:

- A `Drift` tab inside each Terraform project workspace
- Summary counts and filters for `in_sync`, `drifted`, `missing_in_aws`, `unmanaged_in_aws`, and `unsupported`
- Per-item details including Terraform address, resource type, logical name, cloud identifier, region, explanation, and suggested next step
- AWS console shortcuts for matched live resources
- A terminal shortcut for `terraform state show` on supported Terraform-managed items
- Clear `unsupported` labeling for Terraform AWS resource types not yet covered by the initial comparison set

Initial drift coverage includes:

- EC2 instances
- Security groups
- VPCs
- Subnets
- S3 buckets
- Lambda functions
- RDS instances
- ECR repositories
Manage local Terraform projects from within the app. Discover project folders, run `plan`, `apply`, `destroy`, and other CLI commands, and visualize Terraform state — all without leaving the console.

### Cross-Platform Desktop App
Built with Electron and packaged via `electron-builder` for Windows (NSIS installer), macOS (DMG + ZIP), and Linux (deb + AppImage). Native `node-pty` is unpacked from ASAR automatically so the terminal works in production builds.

### Modern Tech Stack
React 18 renderer, TypeScript with strict checking, `electron-vite` for fast HMR development, and AWS SDK for JavaScript v3 with modular service clients for minimal bundle size.

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
- `src/main/terraformDrift.ts`: Terraform drift normalization and live AWS comparison logic
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
- Drift detection is intentionally incremental. It compares existence, selected identifiers, and important attributes for a supported subset of AWS resource types rather than attempting full Terraform semantic diffing.
- Packaging unpacks `node-pty` from ASAR so the terminal works in packaged builds.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the expected workflow, testing expectations, and documentation rules.

## License

MIT. See [LICENSE](./LICENSE).

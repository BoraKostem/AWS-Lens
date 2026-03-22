# Contributing to AWS Lens

This repository is the Electron migration of [AWS Lens](https://github.com/BoraKostem/AWS-Lens-old). Contributions should match the current app architecture: Electron main process, preload bridge, React renderer, shared types, AWS SDK v3 integrations, and Terraform workspace support.

## Development Setup

```powershell
pnpm install
pnpm dev
```

Useful verification commands:

```powershell
pnpm typecheck
pnpm build
```

## How To Contribute

1. Keep the change focused.
2. Verify the affected workflow locally.
3. Update documentation when behavior, setup, or packaging changes.
4. Include screenshots or recordings for visible UI changes.
5. Call out environment requirements such as AWS credentials, Terraform CLI, `kubectl`, or `docker` when they matter.

## Architecture Rules

- Put AWS API access and privileged operations in `src/main/`.
- Expose renderer-facing functionality through `src/preload/index.ts`.
- Keep shared request and response types in `src/shared/types.ts`.
- Keep renderer components in `src/renderer/src/`.
- Do not bypass the preload bridge from renderer code.
- Keep Electron security assumptions intact: `contextIsolation` is enabled and `nodeIntegration` is disabled.

## Testing Expectations

There is no dedicated automated test suite in this repository yet, so contributors should at minimum:

- run `pnpm typecheck`
- run `pnpm build` when changing build, packaging, preload, or shared type boundaries
- manually exercise the changed workflow in `pnpm dev`

If your change touches AWS actions, mention:

- which service area you tested
- which profile/region assumptions were used
- whether the flow is read-only or mutating

If your change touches Terraform support, mention:

- Terraform CLI version used
- sample project shape or module type tested
- whether variable file and saved input flows were exercised

## Documentation Expectations

- Keep `README.md` aligned with the actual Electron app, not the legacy Python version.
- Update setup commands whenever `package.json` scripts or packaging behavior changes.
- Document new local prerequisites when a feature depends on external tools.

## Pull Request Guidance

- Avoid unrelated refactors or formatting churn.
- Preserve existing behavior unless the change is intentional and explained.
- Prefer small IPC surfaces over large generic bridges.
- Preserve destructive-action safeguards and confirmation flows unless there is a clear replacement.
- Note any packaging impact, especially around Electron, preload behavior, or native modules such as `node-pty`.

## Reporting Bugs

Include:

- the screen or service involved
- the selected AWS profile and region if relevant
- the expected result
- the actual result
- error text, logs, and screenshots if available
- whether the issue appears only in `pnpm dev`, only in packaged builds, or both

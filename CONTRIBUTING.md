# Contributing to InfraLens

InfraLens is the Electron desktop app in this repository. The project now spans AWS, Google Cloud, Azure, Terraform, and shared operational workspaces, so changes should fit the current product shape instead of the older single-provider framing.

## Development Setup

Use the same baseline as the release workflow when possible:

- Node.js `22`
- `pnpm` `10`

Install and start the app:

```powershell
pnpm install
pnpm dev
```

Useful verification commands:

```powershell
pnpm typecheck
pnpm build
```

If your change affects packaging, installers, or update metadata, also use the relevant `pnpm dist:*` command before you open a pull request.

## Before You Open A Pull Request

- Keep the change focused. Avoid mixing bug fixes, refactors, and copy edits unless they belong to the same problem.
- Verify the affected flow locally in `pnpm dev`.
- Run `pnpm typecheck`.
- Run `pnpm build` when you touch shared types, preload contracts, Electron wiring, packaging, or anything that can break a production bundle.
- Update documentation when setup, behavior, screenshots, or product positioning changes.
- Include screenshots or short recordings for visible UI changes.

## Architecture Guardrails

InfraLens is split across standard Electron boundaries. Keep those lines clear.

- Put privileged work in `src/main/`.
- Expose renderer-safe APIs through `src/preload/index.ts`.
- Keep shared contracts in `src/shared/`.
- Keep UI code in `src/renderer/src/`.
- Do not bypass the preload bridge from renderer code.
- Preserve `contextIsolation` and keep `nodeIntegration` disabled.

If a feature can mutate cloud state, touch credentials, or run local commands, it belongs behind the Electron main-process boundary. The renderer should describe intent, not own the unsafe operation.

## Provider Guidance

InfraLens is now multi-cloud. Contributions should stay provider-aware.

- Do not describe the product as AWS-only in docs, UI copy, or release notes.
- If you add a new provider-specific workflow, keep naming, connection context, and navigation consistent with the shared provider model.
- If a change only works for one provider, say so clearly in the UI and in the PR.
- Keep read-only and operator-mode behavior intact for any flow that can change infrastructure.
- Treat Terraform and OpenTofu support as first-class workflows, not side utilities.

When a change touches cloud integrations, note what you tested:

- AWS: service area, profile assumptions, region, and whether the flow was read-only or mutating
- GCP: project, location, auth mode, and any `gcloud` dependency
- Azure: tenant or subscription context, location, auth path, and any `az` dependency
- Terraform/OpenTofu: CLI used, sample project shape, workspace behavior, and whether plan or apply paths were exercised

## Testing Expectations

There is no dedicated automated test suite in this repository yet, so local verification matters.

At minimum:

- run `pnpm typecheck`
- run `pnpm build` when the change can affect packaging or runtime boundaries
- manually exercise the changed workflow in `pnpm dev`

For terminal, credential, or destructive-operation changes, verify the guardrails as well as the happy path. A feature is not done if the success case works but the safety checks regress.

## Documentation Expectations

- Keep `README.md` aligned with the current InfraLens product and Electron codebase.
- Use real commands from `package.json`; do not invent setup steps.
- Update screenshots when the visible UI changes enough that the existing images mislead people.
- Document new environment requirements when a workflow depends on external CLIs or provider auth setup.

## Bug Reports

When reporting or triaging bugs, include:

- the screen or workflow involved
- the provider and service area
- account, project, or subscription context when relevant
- expected result
- actual result
- logs, error text, screenshots, or diagnostics when available
- whether the issue happens in `pnpm dev`, packaged builds, or both

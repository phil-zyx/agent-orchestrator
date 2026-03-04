# Repository Guidelines

## Project Structure & Module Organization
This repository is a `pnpm` monorepo.

- `packages/core`: shared types, config loading, lifecycle/session managers.
- `packages/cli`: `ao` command implementation.
- `packages/web`: Next.js dashboard and websocket terminal servers.
- `packages/plugins/*`: pluggable runtimes, agents, trackers, SCM, notifiers, and terminals.
- `packages/integration-tests`: end-to-end tests (`*.integration.test.ts`).
- `packages/mobile`: React Native client.
- `docs/`, `examples/`, `scripts/`, `tests/integration/`: docs, sample configs, tooling, onboarding test harness.

## Build, Test, and Development Commands
Run from repo root unless noted.

- `pnpm install`: install all workspace dependencies.
- `pnpm build`: build all packages (required before `pnpm dev`).
- `pnpm dev`: start web dashboard dev stack (`@composio/ao-web`).
- `pnpm test`: run workspace tests (excludes web package at root level).
- `pnpm test:integration`: run integration suite in `packages/integration-tests`.
- `pnpm lint` / `pnpm typecheck`: run ESLint and TypeScript checks.
- `pnpm --filter @composio/ao-core test`: run tests for one package.

## Coding Style & Naming Conventions
- TypeScript + ESM throughout; use `.js` extension in local imports.
- Prettier enforced: 2 spaces, semicolons, double quotes, trailing commas.
- ESLint uses strict TypeScript rules (`no-explicit-any`, `consistent-type-imports`).
- Prefer `type` imports and `node:` built-in imports.
- Plugin naming pattern: directory `packages/plugins/<slot>-<name>`, package `@composio/ao-plugin-<slot>-<name>`.

## Testing Guidelines
- Framework: Vitest (unit/integration by package).
- Unit tests: `*.test.ts` (often under `__tests__/`).
- Integration tests: `packages/integration-tests/src/**/*.integration.test.ts`.
- No global coverage threshold is configured; keep or improve coverage for touched code and ensure CI test jobs pass.

## Commit & Pull Request Guidelines
- Use Conventional Commits (observed history: `feat:`, `fix:`, `chore:`), optionally with scope and issue/PR reference.
- Prefer short-lived topic branches (example: `feat/url-onboarding`).
- Before opening a PR, run: `pnpm lint && pnpm typecheck && pnpm test`.
- Include clear description, linked issue, and UI screenshots for dashboard/mobile changes.
- For publishable package changes, add a changeset: `pnpm changeset`.

## Security & Configuration Tips
- Pre-commit hook runs `gitleaks protect --staged`; install `gitleaks` locally.
- Never commit secrets; use environment variables and local `.env.local`.
- Use `agent-orchestrator.yaml.example` as the safe template when updating config docs.

/**
 * Pre-flight checks for `ao start` and `ao spawn`.
 *
 * Validates runtime prerequisites before entering the main command flow,
 * giving clear errors instead of cryptic failures.
 *
 * All checks throw on failure so callers can catch and handle uniformly.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "@composio/ao-core";
import { isPortAvailable } from "./web-dir.js";
import { exec } from "./shell.js";

/**
 * Check that the dashboard port is free.
 * Throws if the port is already in use.
 */
async function checkPort(port: number): Promise<void> {
  const free = await isPortAvailable(port);
  if (!free) {
    throw new Error(
      `Port ${port} is already in use. Free it or change 'port' in agent-orchestrator.yaml.`,
    );
  }
}

/**
 * Check that workspace packages have been compiled (TypeScript → JavaScript).
 * Verifies @composio/ao-core dist output exists from the web package's
 * node_modules, since a missing dist/ causes module resolution errors when
 * starting the dashboard. Works with both `next dev` and `next build`.
 */
async function checkBuilt(webDir: string): Promise<void> {
  const nodeModules = resolve(webDir, "node_modules", "@composio", "ao-core");
  if (!existsSync(nodeModules)) {
    throw new Error("Dependencies not installed. Run: pnpm install && pnpm build");
  }
  const coreEntry = resolve(nodeModules, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    throw new Error("Packages not built. Run: pnpm build");
  }
}

/**
 * Check that tmux is installed (required for the default runtime).
 * Throws if not installed.
 */
async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    throw new Error("tmux is not installed. Install it: brew install tmux");
  }
}

/**
 * Check that the GitHub CLI is installed and authenticated.
 * Distinguishes between "not installed" and "not authenticated"
 * so the user gets the right troubleshooting guidance.
 */
async function checkGhAuth(): Promise<void> {
  try {
    await exec("gh", ["--version"]);
  } catch {
    throw new Error("GitHub CLI (gh) is not installed. Install it: https://cli.github.com/");
  }

  try {
    await exec("gh", ["auth", "status"]);
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
  }
}

/**
 * Check that GitLab authentication is configured.
 * Accepts either project-level `tracker.token` or environment variables.
 */
function checkGitLabToken(project: ProjectConfig): void {
  const trackerConfig =
    project.tracker && typeof project.tracker === "object"
      ? (project.tracker as Record<string, unknown>)
      : undefined;
  const tokenFromConfig = trackerConfig?.["token"];
  const tokenFromEnv =
    process.env["GITLAB_TOKEN"] ?? process.env["GITLAB_API_TOKEN"] ?? process.env["GITLAB_PAT"];

  if (typeof tokenFromConfig === "string" && tokenFromConfig.trim().length > 0) return;
  if (tokenFromEnv && tokenFromEnv.trim().length > 0) return;

  throw new Error(
    "GitLab token is not configured. Set project.tracker.token or GITLAB_TOKEN environment variable.",
  );
}

export const preflight = {
  checkPort,
  checkBuilt,
  checkTmux,
  checkGhAuth,
  checkGitLabToken,
};

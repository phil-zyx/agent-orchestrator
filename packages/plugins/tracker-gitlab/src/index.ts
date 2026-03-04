/**
 * tracker-gitlab plugin — GitLab Issues as an issue tracker.
 *
 * Supports both gitlab.com and self-hosted GitLab instances.
 * Authentication:
 *   1) project.tracker.token
 *   2) GITLAB_TOKEN / GITLAB_API_TOKEN / GITLAB_PAT
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

type GitLabState = "opened" | "closed";

interface GitLabUser {
  id: number;
  username: string;
  name?: string;
}

interface GitLabIssueResponse {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: GitLabState | string;
  labels: string[];
  assignee: GitLabUser | null;
  assignees?: GitLabUser[];
}

type GitLabQueryValue = string | number | boolean | null | undefined;

interface GitLabRequestOptions {
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, GitLabQueryValue>;
  body?: Record<string, unknown>;
}

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getTrackerConfig(project: ProjectConfig): {
  baseUrl: string;
  token: string;
  projectPath: string;
} {
  const trackerConfig =
    project.tracker && typeof project.tracker === "object"
      ? (project.tracker as Record<string, unknown>)
      : undefined;

  const baseUrl =
    readConfigString(trackerConfig, "baseUrl") ??
    process.env["GITLAB_BASE_URL"] ??
    "https://gitlab.com";

  const token =
    readConfigString(trackerConfig, "token") ??
    process.env["GITLAB_TOKEN"] ??
    process.env["GITLAB_API_TOKEN"] ??
    process.env["GITLAB_PAT"];

  if (!token) {
    throw new Error(
      "GitLab token is required. Set project.tracker.token or GITLAB_TOKEN environment variable.",
    );
  }

  if (!project.repo || !project.repo.includes("/")) {
    throw new Error(`Invalid repo format "${project.repo}", expected "group/project"`);
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    projectPath: project.repo,
  };
}

async function gitlabRequest<T>(
  project: ProjectConfig,
  path: string,
  options: GitLabRequestOptions = {},
): Promise<T> {
  const { baseUrl, token, projectPath } = getTrackerConfig(project);
  const projectId = encodeURIComponent(projectPath);
  const url = new URL(`${baseUrl}/api/v4/projects/${projectId}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "PRIVATE-TOKEN": token,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitLab API ${options.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`GitLab API request timed out after 30s (${path})`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeIssueIdentifier(identifier: string): string {
  const trimmed = identifier.trim().replace(/^#/, "");
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid issue format: "${identifier}" (expected numeric issue IID)`);
  }
  return trimmed;
}

function mapIssueState(state: string): Issue["state"] {
  const normalized = state.toLowerCase();
  return normalized === "closed" ? "closed" : "open";
}

function mapIssue(data: GitLabIssueResponse): Issue {
  const primaryAssignee = data.assignees?.[0] ?? data.assignee ?? null;
  return {
    id: String(data.iid),
    title: data.title,
    description: data.description ?? "",
    url: data.web_url,
    state: mapIssueState(data.state),
    labels: data.labels ?? [],
    assignee: primaryAssignee?.username ?? primaryAssignee?.name,
  };
}

async function resolveUserId(project: ProjectConfig, username: string): Promise<number | null> {
  const normalized = username.replace(/^@/, "").trim();
  if (!normalized) return null;

  const users = await gitlabRequest<GitLabUser[]>(
    project,
    "/users",
    { query: { username: normalized, per_page: 1 } },
  );

  return users[0]?.id ?? null;
}

function buildIssueUrl(identifier: string, project: ProjectConfig): string {
  const { baseUrl } = getTrackerConfig(project);
  const issueId = identifier.replace(/^#/, "");
  return `${baseUrl}/${project.repo}/-/issues/${issueId}`;
}

function createGitLabTracker(): Tracker {
  return {
    name: "gitlab",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const issueId = normalizeIssueIdentifier(identifier);
      try {
        const data = await gitlabRequest<GitLabIssueResponse>(project, `/issues/${issueId}`);
        return mapIssue(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("(404)")) {
          throw new Error(`Issue ${issueId} not found`);
        }
        throw err;
      }
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await this.getIssue(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      return buildIssueUrl(identifier, project);
    },

    issueLabel(url: string): string {
      const match = url.match(/\/-\/issues\/(\d+)/);
      if (match) return `#${match[1]}`;
      const last = url.split("/").filter(Boolean).pop();
      return last ? `#${last}` : url;
    },

    branchName(identifier: string): string {
      const issueId = normalizeIssueIdentifier(identifier);
      return `feat/issue-${issueId}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitLab issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const state =
        filters.state === "closed" ? "closed" : filters.state === "all" ? "all" : "opened";

      const data = await gitlabRequest<GitLabIssueResponse[]>(project, "/issues", {
        query: {
          state,
          labels: filters.labels && filters.labels.length > 0 ? filters.labels.join(",") : undefined,
          assignee_username: filters.assignee,
          per_page: filters.limit ?? 30,
          scope: "all",
        },
      });

      return data.map(mapIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const issueId = normalizeIssueIdentifier(identifier);
      const body: Record<string, unknown> = {};

      if (update.state === "closed") {
        body["state_event"] = "close";
      } else if (update.state === "open") {
        body["state_event"] = "reopen";
      }

      if (update.labels && update.labels.length > 0) {
        const current = await this.getIssue(issueId, project);
        const merged = [...new Set([...current.labels, ...update.labels])];
        body["labels"] = merged.join(",");
      }

      if (update.assignee) {
        const assigneeId = await resolveUserId(project, update.assignee);
        if (assigneeId !== null) {
          body["assignee_ids"] = [assigneeId];
        }
      }

      if (Object.keys(body).length > 0) {
        await gitlabRequest(project, `/issues/${issueId}`, {
          method: "PUT",
          body,
        });
      }

      if (update.comment) {
        await gitlabRequest(project, `/issues/${issueId}/notes`, {
          method: "POST",
          body: { body: update.comment },
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const body: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
      };

      if (input.labels && input.labels.length > 0) {
        body["labels"] = input.labels.join(",");
      }

      if (input.assignee) {
        const assigneeId = await resolveUserId(project, input.assignee);
        if (assigneeId !== null) {
          body["assignee_ids"] = [assigneeId];
        }
      }

      const created = await gitlabRequest<GitLabIssueResponse>(project, "/issues", {
        method: "POST",
        body,
      });

      return mapIssue(created);
    },
  };
}

export const manifest = {
  name: "gitlab",
  slot: "tracker" as const,
  description: "Tracker plugin: GitLab Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitLabTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;

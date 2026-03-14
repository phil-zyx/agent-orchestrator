/**
 * scm-gitlab plugin — GitLab Merge Requests, CI, reviews, merge readiness.
 *
 * Supports both gitlab.com and self-hosted GitLab instances.
 * Authentication:
 *   1) project.scm.token (available when detectPR is called)
 *   2) GITLAB_TOKEN / GITLAB_API_TOKEN / GITLAB_PAT
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
} from "@composio/ao-core";

type GitLabQueryValue = string | number | boolean | null | undefined;

interface GitLabRequestOptions {
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, GitLabQueryValue>;
  body?: Record<string, unknown>;
}

interface GitLabCredentials {
  baseUrl: string;
  token: string;
}

const execFileAsync = promisify(execFile);

function formatError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    const message = current.message.trim();
    if (message && !parts.includes(message)) {
      parts.push(message);
    }
    current = current.cause;
  }

  return parts.length > 0 ? parts.join(": ") : err.toString();
}

interface GitLabUser {
  username: string;
}

interface GitLabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: string;
  draft: boolean;
  has_conflicts?: boolean;
  blocking_discussions_resolved?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
  head_pipeline?: {
    id: number;
    status: string;
    web_url?: string;
    created_at?: string;
    updated_at?: string;
  } | null;
}

interface GitLabPipelineJob {
  id: number;
  name: string;
  status: string;
  web_url?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

interface GitLabApprovalsResponse {
  approvals_required: number;
  approvals_left: number;
  approved_by: Array<{
    user: GitLabUser;
    approved_at?: string | null;
  }>;
}

interface GitLabDiscussionNote {
  id: number;
  body: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  created_at: string;
  web_url?: string;
  author?: GitLabUser;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
}

interface GitLabDiscussion {
  id: string;
  resolved: boolean;
  notes: GitLabDiscussionNote[];
}

const BOT_AUTHORS = new Set([
  "gitlab-bot",
  "renovate-bot",
  "dependabot",
  "sonarqube",
  "codecov",
  "snyk-bot",
]);

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseDate(value: string | undefined | null): Date {
  if (!value) return new Date(0);
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function isBotAuthor(username: string | undefined): boolean {
  if (!username) return false;
  const normalized = username.toLowerCase();
  return (
    BOT_AUTHORS.has(normalized) ||
    normalized.endsWith("[bot]") ||
    normalized.endsWith("-bot")
  );
}

function toPrState(state: string): PRState {
  const normalized = state.toLowerCase();
  if (normalized === "merged") return "merged";
  if (normalized === "closed") return "closed";
  return "open";
}

function getNamespace(projectPath: string): { owner: string; repo: string } {
  const segments = projectPath.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid project namespace "${projectPath}"`);
  }
  return {
    owner: segments[0],
    repo: segments.slice(1).join("/"),
  };
}

function projectPathFromPr(pr: PRInfo): string {
  if (pr.owner && pr.repo) return `${pr.owner}/${pr.repo}`;

  const match = pr.url.match(/^https?:\/\/[^/]+\/(.+)\/-\/merge_requests\/\d+$/);
  if (match?.[1]) return match[1];

  throw new Error(`Could not resolve project namespace from MR URL: ${pr.url}`);
}

function getConfig(project: ProjectConfig): {
  projectPath: string;
  baseUrl: string;
  token: string;
} {
  const scmConfig =
    project.scm && typeof project.scm === "object"
      ? (project.scm as Record<string, unknown>)
      : undefined;

  const baseUrl =
    readConfigString(scmConfig, "baseUrl") ??
    process.env["GITLAB_BASE_URL"] ??
    "https://gitlab.com";

  const token =
    readConfigString(scmConfig, "token") ??
    process.env["GITLAB_TOKEN"] ??
    process.env["GITLAB_API_TOKEN"] ??
    process.env["GITLAB_PAT"];

  if (!project.repo || !project.repo.includes("/")) {
    throw new Error(`Invalid repo format "${project.repo}", expected "group/project"`);
  }
  if (!token) {
    throw new Error(
      "GitLab token is required. Set project.scm.token or GITLAB_TOKEN environment variable.",
    );
  }

  return {
    projectPath: project.repo,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
  };
}

async function gitlabRequest<T>(
  creds: GitLabCredentials,
  projectPath: string,
  path: string,
  options: GitLabRequestOptions = {},
): Promise<T> {
  const projectId = encodeURIComponent(projectPath);
  const url = new URL(`${creds.baseUrl}/api/v4/projects/${projectId}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const method = options.method ?? "GET";
  const statusMarker = "__AO_STATUS__:";
  const args = [
    "--silent",
    "--show-error",
    "--http1.1",
    "--location",
    "--request",
    method,
    "--header",
    "Accept: application/json",
    "--header",
    `PRIVATE-TOKEN: ${creds.token}`,
    "--write-out",
    `${statusMarker}%{http_code}`,
    url.toString(),
  ];

  if (options.body) {
    args.splice(args.length - 3, 0, "--header", "Content-Type: application/json");
    args.splice(args.length - 3, 0, "--data", JSON.stringify(options.body));
  }

  try {
    const { stdout } = await execFileAsync("curl", args, {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const markerIndex = stdout.lastIndexOf(statusMarker);
    if (markerIndex === -1) {
      throw new Error("curl response missing status marker");
    }

    const text = stdout.slice(0, markerIndex);
    const status = Number.parseInt(stdout.slice(markerIndex + statusMarker.length).trim(), 10);

    if (!Number.isFinite(status)) {
      throw new Error("curl response contained invalid HTTP status");
    }
    if (status < 200 || status >= 300) {
      throw new Error(
        `GitLab API ${method} ${path} failed (${status}): ${text.slice(0, 300)}`,
      );
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof Error && err.message.includes("timed out")) {
      throw new Error(`GitLab API request timed out after 30s (${path})`);
    }
    throw new Error(
      `GitLab API ${method} ${url.pathname} failed: ${formatError(err)}`,
      { cause: err },
    );
  }
}

function mapJobStatus(status: string): CICheck["status"] {
  const normalized = status.toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "created" ||
    normalized === "preparing" ||
    normalized === "scheduled" ||
    normalized === "waiting_for_resource"
  ) {
    return "pending";
  }
  if (normalized === "running") return "running";
  if (normalized === "success") return "passed";
  if (normalized === "skipped" || normalized === "manual") return "skipped";
  if (normalized === "canceled" || normalized === "cancelled" || normalized === "failed") {
    return "failed";
  }
  return "failed";
}

function mapPipelineStatus(status: string): CICheck["status"] {
  return mapJobStatus(status);
}

function severityFromBody(body: string): AutomatedComment["severity"] {
  const lower = body.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("bug") ||
    lower.includes("critical") ||
    lower.includes("security")
  ) {
    return "error";
  }
  if (lower.includes("warning") || lower.includes("suggest") || lower.includes("consider")) {
    return "warning";
  }
  return "info";
}

function createGitLabSCM(): SCM {
  const credentialsByProjectPath = new Map<string, GitLabCredentials>();

  function cacheCredentials(projectPath: string, creds: GitLabCredentials): void {
    credentialsByProjectPath.set(projectPath, creds);
  }

  function resolveCredentials(projectPath: string, prUrl?: string): GitLabCredentials {
    const cached = credentialsByProjectPath.get(projectPath);
    if (cached) return cached;

    const token =
      process.env["GITLAB_TOKEN"] ?? process.env["GITLAB_API_TOKEN"] ?? process.env["GITLAB_PAT"];

    if (!token) {
      throw new Error(
        `GitLab token not found for ${projectPath}. Set GITLAB_TOKEN or configure project.scm.token.`,
      );
    }

    const urlBase =
      process.env["GITLAB_BASE_URL"] ??
      (() => {
        if (!prUrl) return "https://gitlab.com";
        try {
          const parsed = new URL(prUrl);
          return `${parsed.protocol}//${parsed.host}`;
        } catch {
          return "https://gitlab.com";
        }
      })();

    const creds: GitLabCredentials = { baseUrl: urlBase.replace(/\/+$/, ""), token };
    cacheCredentials(projectPath, creds);
    return creds;
  }

  async function getMergeRequest(pr: PRInfo): Promise<{
    projectPath: string;
    creds: GitLabCredentials;
    data: GitLabMergeRequest;
  }> {
    const projectPath = projectPathFromPr(pr);
    const creds = resolveCredentials(projectPath, pr.url);
    const data = await gitlabRequest<GitLabMergeRequest>(creds, projectPath, `/merge_requests/${pr.number}`);
    return { projectPath, creds, data };
  }

  async function getApprovals(
    pr: PRInfo,
    projectPath: string,
    creds: GitLabCredentials,
  ): Promise<GitLabApprovalsResponse> {
    return gitlabRequest<GitLabApprovalsResponse>(
      creds,
      projectPath,
      `/merge_requests/${pr.number}/approvals`,
    );
  }

  async function getDiscussions(
    pr: PRInfo,
    projectPath: string,
    creds: GitLabCredentials,
  ): Promise<GitLabDiscussion[]> {
    return gitlabRequest<GitLabDiscussion[]>(
      creds,
      projectPath,
      `/merge_requests/${pr.number}/discussions`,
      { query: { per_page: 100 } },
    );
  }

  return {
    name: "gitlab",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const config = getConfig(project);
      cacheCredentials(config.projectPath, { baseUrl: config.baseUrl, token: config.token });

      const mergeRequests = await gitlabRequest<GitLabMergeRequest[]>(
        { baseUrl: config.baseUrl, token: config.token },
        config.projectPath,
        "/merge_requests",
        {
          query: {
            state: "opened",
            source_branch: session.branch,
            per_page: 1,
            order_by: "updated_at",
            sort: "desc",
          },
        },
      );

      if (mergeRequests.length === 0) return null;

      const mr = mergeRequests[0];
      const namespace = getNamespace(config.projectPath);
      return {
        number: mr.iid,
        url: mr.web_url,
        title: mr.title,
        owner: namespace.owner,
        repo: namespace.repo,
        branch: mr.source_branch,
        baseBranch: mr.target_branch,
        isDraft: mr.draft,
      };
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const { data } = await getMergeRequest(pr);
      return toPrState(data.state);
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const { projectPath, creds } = await getMergeRequest(pr);
      await gitlabRequest(creds, projectPath, `/merge_requests/${pr.number}/merge`, {
        method: "PUT",
        body: {
          squash: method === "squash",
          should_remove_source_branch: true,
          merge_when_pipeline_succeeds: false,
        },
      });
    },

    async closePR(pr: PRInfo): Promise<void> {
      const { projectPath, creds } = await getMergeRequest(pr);
      await gitlabRequest(creds, projectPath, `/merge_requests/${pr.number}`, {
        method: "PUT",
        body: { state_event: "close" },
      });
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      const { projectPath, creds, data: mr } = await getMergeRequest(pr);
      const pipeline = mr.head_pipeline;
      if (!pipeline?.id) return [];

      const jobs = await gitlabRequest<GitLabPipelineJob[]>(
        creds,
        projectPath,
        `/pipelines/${pipeline.id}/jobs`,
        { query: { per_page: 100 } },
      );

      if (jobs.length === 0) {
        return [
          {
            name: "pipeline",
            status: mapPipelineStatus(pipeline.status),
            url: pipeline.web_url,
            conclusion: pipeline.status,
            startedAt: parseDate(pipeline.created_at),
            completedAt: parseDate(pipeline.updated_at),
          },
        ];
      }

      return jobs.map((job) => ({
        name: job.name,
        status: mapJobStatus(job.status),
        url: job.web_url,
        conclusion: job.status,
        startedAt: parseDate(job.started_at),
        completedAt: parseDate(job.finished_at),
      }));
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      const checks = await this.getCIChecks(pr);
      if (checks.length === 0) return CI_STATUS.NONE;

      if (checks.some((check) => check.status === "failed")) return CI_STATUS.FAILING;
      if (checks.some((check) => check.status === "pending" || check.status === "running")) {
        return CI_STATUS.PENDING;
      }
      if (checks.some((check) => check.status === "passed")) return CI_STATUS.PASSING;
      return CI_STATUS.NONE;
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const { projectPath, creds } = await getMergeRequest(pr);
      const approvals = await getApprovals(pr, projectPath, creds);
      const pending = await this.getPendingComments(pr);

      const reviews: Review[] = approvals.approved_by.map((entry) => ({
        author: entry.user.username,
        state: "approved",
        submittedAt: parseDate(entry.approved_at),
      }));

      const seenChangeRequests = new Set<string>();
      for (const comment of pending) {
        if (!seenChangeRequests.has(comment.author)) {
          reviews.push({
            author: comment.author,
            state: "changes_requested",
            body: comment.body,
            submittedAt: comment.createdAt,
          });
          seenChangeRequests.add(comment.author);
        }
      }

      return reviews;
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const { projectPath, creds } = await getMergeRequest(pr);

      const pending = await this.getPendingComments(pr);
      if (pending.length > 0) return "changes_requested";

      const approvals = await getApprovals(pr, projectPath, creds);
      if (approvals.approved_by.length > 0) return "approved";
      if (approvals.approvals_required > 0) return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      const { projectPath, creds } = await getMergeRequest(pr);
      const discussions = await getDiscussions(pr, projectPath, creds);
      const comments: ReviewComment[] = [];

      for (const discussion of discussions) {
        if (discussion.resolved) continue;

        const note = discussion.notes.find((candidate) => {
          const author = candidate.author?.username;
          if (!author || isBotAuthor(author)) return false;
          if (candidate.system) return false;
          const unresolved = candidate.resolvable ? !candidate.resolved : true;
          return unresolved;
        });

        if (!note) continue;

        comments.push({
          id: String(note.id),
          author: note.author?.username ?? "unknown",
          body: note.body,
          path: note.position?.new_path ?? note.position?.old_path ?? undefined,
          line: note.position?.new_line ?? note.position?.old_line ?? undefined,
          isResolved: false,
          createdAt: parseDate(note.created_at),
          url: note.web_url ?? `${pr.url}#note_${note.id}`,
        });
      }

      return comments;
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      const { projectPath, creds } = await getMergeRequest(pr);
      const discussions = await getDiscussions(pr, projectPath, creds);
      const comments: AutomatedComment[] = [];

      for (const discussion of discussions) {
        for (const note of discussion.notes) {
          const author = note.author?.username;
          if (!author || !isBotAuthor(author)) continue;
          if (note.system) continue;

          comments.push({
            id: String(note.id),
            botName: author,
            body: note.body,
            path: note.position?.new_path ?? note.position?.old_path ?? undefined,
            line: note.position?.new_line ?? note.position?.old_line ?? undefined,
            severity: severityFromBody(note.body),
            createdAt: parseDate(note.created_at),
            url: note.web_url ?? `${pr.url}#note_${note.id}`,
          });
        }
      }

      return comments;
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];
      const addBlocker = (msg: string) => {
        if (!blockers.includes(msg)) blockers.push(msg);
      };

      const { data: mr } = await getMergeRequest(pr);
      if (toPrState(mr.state) === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) addBlocker(`CI is ${ciStatus}`);

      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved" || reviewDecision === "none";
      if (reviewDecision === "changes_requested") addBlocker("Unresolved review comments");
      if (reviewDecision === "pending") addBlocker("Required approvals are missing");

      const noConflicts = !mr.has_conflicts && mr.merge_status !== "cannot_be_merged";
      if (!noConflicts) addBlocker("Merge conflicts detected");

      if (mr.draft) addBlocker("Merge request is draft");
      if (mr.blocking_discussions_resolved === false) addBlocker("Blocking discussions unresolved");

      const mergeStatus = (mr.detailed_merge_status ?? "").toLowerCase();
      if (mergeStatus === "checking") addBlocker("Merge status still checking");
      if (mergeStatus === "ci_still_running") addBlocker("CI is still running");
      if (mergeStatus === "ci_must_pass") addBlocker("Required CI checks must pass");
      if (mergeStatus === "not_approved") addBlocker("Approval required before merge");
      if (mergeStatus === "need_rebase") addBlocker("Branch needs rebase");
      if (mergeStatus === "discussions_not_resolved") addBlocker("Discussions are not resolved");

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

export const manifest = {
  name: "gitlab",
  slot: "scm" as const,
  description: "SCM plugin: GitLab MRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitLabSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;

/**
 * WOPR GitHub Plugin
 *
 * Orchestrates GitHub integration:
 * - Sets up org webhooks via gh CLI
 * - Uses funnel extension for public URL
 * - Uses webhooks extension for routing config
 */

import { execSync, spawnSync } from "node:child_process";
import type {
  WOPRPlugin,
  WOPRPluginContext,
  GitHubConfig,
  GitHubExtension,
  GitHubItemSummary,
  WebhookSetupResult,
  WebhookEvent,
  WebhookRouteResult,
  FunnelExtension,
  WebhooksExtension,
} from "./types.js";

// ============================================================================
// State
// ============================================================================

let ctx: WOPRPluginContext | null = null;

// ============================================================================
// Helpers
// ============================================================================

function exec(cmd: string): { stdout: string; success: boolean } {
  try {
    const stdout = execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
    return { stdout, success: true };
  } catch (err: any) {
    return { stdout: err.stderr || err.message || "", success: false };
  }
}

/**
 * Execute gh CLI with array of arguments (avoids shell escaping issues)
 */
function execGh(args: string[]): { stdout: string; success: boolean } {
  try {
    const result = spawnSync("gh", args, {
      encoding: "utf-8",
      timeout: 30000,
    });
    if (result.status === 0) {
      return { stdout: (result.stdout || "").trim(), success: true };
    }
    return { stdout: (result.stderr || result.stdout || "").trim(), success: false };
  } catch (err: any) {
    return { stdout: err.message || "", success: false };
  }
}

async function checkGhAuth(): Promise<boolean> {
  const result = exec("gh auth status");
  return result.success;
}

function getFunnelExtension(): FunnelExtension | null {
  return (ctx?.getExtension?.("funnel") as FunnelExtension) || null;
}

function getWebhooksExtension(): WebhooksExtension | null {
  return (ctx?.getExtension?.("webhooks") as WebhooksExtension) || null;
}

async function getWebhookUrl(): Promise<string | null> {
  const funnel = getFunnelExtension();
  const webhooks = getWebhooksExtension();

  if (!funnel || !webhooks) {
    ctx?.log.debug?.("Funnel or webhooks extension not available");
    return null;
  }

  const webhooksConfig = webhooks.getConfig();
  if (!webhooksConfig) {
    ctx?.log.debug?.("Webhooks not configured");
    return null;
  }

  // Get hostname from funnel
  const hostname = await funnel.getHostname();
  if (!hostname) {
    ctx?.log.debug?.("No Tailscale hostname available");
    return null;
  }

  // Build webhook URL
  // Funnel exposes on HTTPS 443, path is /hooks/github
  return `https://${hostname}${webhooksConfig.basePath}/github`;
}

async function setupOrgWebhook(org: string): Promise<WebhookSetupResult> {
  // Check gh auth
  if (!(await checkGhAuth())) {
    return { success: false, error: "gh CLI not authenticated. Run 'gh auth login' first." };
  }

  // Get webhook URL
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) {
    return { success: false, error: "No webhook URL available. Ensure tailscale-funnel and webhooks plugins are configured." };
  }

  // Get webhook secret from webhooks config
  const webhooks = getWebhooksExtension();
  const webhooksConfig = webhooks?.getConfig();
  if (!webhooksConfig?.token) {
    return { success: false, error: "No webhook token configured" };
  }

  // Check if webhook already exists (use execGh to avoid shell injection)
  const listArgs = [
    "api",
    `orgs/${org}/hooks`,
    "--jq", `.[] | select(.config.url == "${webhookUrl}") | .id`,
  ];
  const listResult = execGh(listArgs);
  if (listResult.success && listResult.stdout) {
    const existingId = parseInt(listResult.stdout, 10);
    if (!isNaN(existingId)) {
      ctx?.log.info(`Webhook already exists for ${org}: ID ${existingId}`);
      return { success: true, webhookUrl, webhookId: existingId };
    }
  }

  // Create webhook using gh api
  // Build args array to avoid shell escaping issues with secret
  const createArgs = [
    "api",
    `orgs/${org}/hooks`,
    "-X", "POST",
    "-f", "name=web",
    "-f", "active=true",
    "-f", `config[url]=${webhookUrl}`,
    "-f", "config[content_type]=json",
    "-f", `config[secret]=${webhooksConfig.token}`,
    "-f", "events[]=pull_request",
    "-f", "events[]=pull_request_review",
    "--jq", ".id",
  ];

  const createResult = execGh(createArgs);
  if (!createResult.success) {
    return { success: false, error: `Failed to create webhook: ${createResult.stdout}` };
  }

  const webhookId = parseInt(createResult.stdout, 10);
  if (isNaN(webhookId)) {
    return { success: false, error: `Invalid webhook ID returned: ${createResult.stdout}` };
  }
  ctx?.log.info(`Created webhook for ${org}: ID ${webhookId}`);

  return { success: true, webhookUrl, webhookId };
}

// ============================================================================
// Event Routing
// ============================================================================

/**
 * Resolve which session an event type should route to.
 *
 * Priority:
 * 1. Exact match in routing table (e.g. "pull_request" -> "code-review")
 * 2. Wildcard "*" in routing table
 * 3. Legacy prReviewSession / releaseSession fields
 * 4. null (no route configured)
 */
function resolveSessionFromConfig(eventType: string): string | null {
  const config = ctx?.getConfig<GitHubConfig>();
  if (!config) return null;

  // 1. Check routing table — exact match
  const exactRoute = config.routing?.[eventType];
  if (typeof exactRoute === "string" && exactRoute.trim() !== "") {
    return exactRoute;
  }

  // 2. Check routing table — wildcard fallback
  const wildcard = config.routing?.["*"];
  if (typeof wildcard === "string" && wildcard.trim() !== "") {
    return wildcard;
  }

  // 3. Legacy field fallback
  if (
    (eventType === "pull_request" || eventType === "pull_request_review") &&
    config.prReviewSession
  ) {
    return config.prReviewSession;
  }
  if (
    (eventType === "release" || eventType === "push") &&
    config.releaseSession
  ) {
    return config.releaseSession;
  }

  return null;
}

// ============================================================================
// PR / Issue Viewing
// ============================================================================

/**
 * Parse "owner/repo#123" into { repo: "owner/repo", num: 123 }.
 * Only supports the "owner/repo#123" format.
 */
function parseRef(input: string): { repo: string; num: number } | null {
  // owner/repo#123
  const hashMatch = input.match(/^([^#\s]+)#(\d+)$/);
  if (hashMatch) {
    return { repo: hashMatch[1], num: parseInt(hashMatch[2], 10) };
  }
  return null;
}

function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  const oneLine = text.replace(/\r?\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

const PR_JSON_FIELDS = [
  "number", "title", "state", "author", "labels", "body", "url",
  "createdAt", "updatedAt", "mergeable", "reviewDecision",
  "additions", "deletions", "headRefName", "baseRefName",
].join(",");

const ISSUE_JSON_FIELDS = [
  "number", "title", "state", "author", "labels", "body", "url",
  "createdAt", "updatedAt",
].join(",");

function viewPr(repo: string, num: number): GitHubItemSummary | null {
  const result = execGh(["pr", "view", String(num), "--repo", repo, "--json", PR_JSON_FIELDS]);
  if (!result.success) {
    ctx?.log.debug?.(`[github] Failed to fetch PR ${repo}#${num}: ${result.stdout}`);
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    return {
      type: "pr",
      repo,
      number: data.number,
      title: data.title,
      state: data.state,
      author: data.author?.login || "unknown",
      labels: (data.labels || []).map((l: any) => l.name),
      bodyPreview: truncate(data.body || "", 200),
      url: data.url,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      mergeable: data.mergeable,
      reviewDecision: data.reviewDecision,
      additions: data.additions,
      deletions: data.deletions,
      headRef: data.headRefName,
      baseRef: data.baseRefName,
    };
  } catch {
    ctx?.log.debug?.(`[github] Failed to parse PR response for ${repo}#${num}`);
    return null;
  }
}

function viewIssue(repo: string, num: number): GitHubItemSummary | null {
  const result = execGh(["issue", "view", String(num), "--repo", repo, "--json", ISSUE_JSON_FIELDS]);
  if (!result.success) {
    ctx?.log.debug?.(`[github] Failed to fetch issue ${repo}#${num}: ${result.stdout}`);
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    return {
      type: "issue",
      repo,
      number: data.number,
      title: data.title,
      state: data.state,
      author: data.author?.login || "unknown",
      labels: (data.labels || []).map((l: any) => l.name),
      bodyPreview: truncate(data.body || "", 200),
      url: data.url,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  } catch {
    ctx?.log.debug?.(`[github] Failed to parse issue response for ${repo}#${num}`);
    return null;
  }
}

function formatSummary(item: GitHubItemSummary): string {
  const lines: string[] = [];
  const typeLabel = item.type === "pr" ? "PR" : "Issue";
  lines.push(`${typeLabel} #${item.number}: ${item.title}`);
  lines.push(`  State: ${item.state}  |  Author: ${item.author}`);
  if (item.labels.length > 0) {
    lines.push(`  Labels: ${item.labels.join(", ")}`);
  }
  if (item.type === "pr") {
    if (item.headRef && item.baseRef) {
      lines.push(`  Branch: ${item.headRef} -> ${item.baseRef}`);
    }
    if (item.additions !== undefined || item.deletions !== undefined) {
      lines.push(`  Changes: +${item.additions || 0} / -${item.deletions || 0}`);
    }
    if (item.reviewDecision) {
      lines.push(`  Review: ${item.reviewDecision}`);
    }
  }
  if (item.bodyPreview) {
    lines.push(`  ${item.bodyPreview}`);
  }
  lines.push(`  ${item.url}`);
  return lines.join("\n");
}

// ============================================================================
// Extension
// ============================================================================

const githubExtension: GitHubExtension = {
  async setupWebhook(org: string) {
    return setupOrgWebhook(org);
  },

  async getWebhookUrl() {
    return getWebhookUrl();
  },

  async isAuthenticated() {
    return checkGhAuth();
  },

  handleWebhook(event: WebhookEvent): WebhookRouteResult {
    const { eventType, deliveryId } = event;

    if (!eventType) {
      return { routed: false, reason: "Missing event type" };
    }

    const session = resolveSessionFromConfig(eventType);
    if (!session) {
      ctx?.log.debug?.(`[github] No route for event type: ${eventType} (delivery: ${deliveryId || "unknown"})`);
      return { routed: false, reason: `No session configured for event type: ${eventType}` };
    }

    ctx?.log.info(`[github] Routing ${eventType} -> session "${session}" (delivery: ${deliveryId || "unknown"})`);
    return { routed: true, session };
  },

  resolveSession(eventType: string): string | null {
    return resolveSessionFromConfig(eventType);
  },

  viewPr(repo: string, num: number): GitHubItemSummary | null {
    return viewPr(repo, num);
  },

  viewIssue(repo: string, num: number): GitHubItemSummary | null {
    return viewIssue(repo, num);
  },
};

// ============================================================================
// Plugin
// ============================================================================

const plugin: WOPRPlugin = {
  name: "wopr-plugin-github",
  version: "1.0.0",
  description: "GitHub integration - webhooks, PRs, repo management",

  configSchema: {
    title: "GitHub Integration",
    description: "Configure GitHub webhooks and PR routing",
    fields: [
      {
        name: "orgs",
        type: "array",
        label: "Organizations",
        description: "GitHub organizations to manage",
      },
      {
        name: "prReviewSession",
        type: "string",
        label: "PR Review Session",
        description: "Session to route PR events to",
        default: "discord:misfits:#pay-no-attention-to-the-man-behind-the-curtain",
      },
      {
        name: "releaseSession",
        type: "string",
        label: "Release Session",
        description: "Session to route merge/release events to",
      },
      {
        name: "routing",
        type: "object",
        label: "Event Routing",
        description:
          'Map GitHub event types to WOPR sessions. Use "*" as catch-all. Example: { "pull_request": "code-review", "issues": "project-mgmt", "*": "default" }',
      },
    ],
  },

  commands: [
    {
      name: "github",
      description: "GitHub integration commands",
      usage: "wopr github <setup|status|pr|issue|webhook|url> [arg]",
      async handler(cmdCtx, args) {
        const [subcommand, orgArg] = args;

        if (subcommand === "status") {
          const authed = await checkGhAuth();
          cmdCtx.log.info(`GitHub CLI: ${authed ? "authenticated" : "not authenticated"}`);

          const webhookUrl = await getWebhookUrl();
          cmdCtx.log.info(`Webhook URL: ${webhookUrl || "not available"}`);

          const config = cmdCtx.getConfig<GitHubConfig>();
          if (config?.orgs?.length) {
            cmdCtx.log.info(`Configured orgs: ${config.orgs.join(", ")}`);
          }
          return;
        }

        if (subcommand === "setup" || subcommand === "webhook") {
          const config = cmdCtx.getConfig<GitHubConfig>();
          const orgs = orgArg ? [orgArg] : config?.orgs || [];

          if (orgs.length === 0) {
            cmdCtx.log.error("No org specified. Usage: wopr github setup <org>");
            return;
          }

          for (const org of orgs) {
            cmdCtx.log.info(`Setting up webhook for ${org}...`);
            const result = await setupOrgWebhook(org);
            if (result.success) {
              cmdCtx.log.info(`  Webhook URL: ${result.webhookUrl}`);
              cmdCtx.log.info(`  Webhook ID: ${result.webhookId}`);
            } else {
              cmdCtx.log.error(`  Failed: ${result.error}`);
            }
          }
          return;
        }

        if (subcommand === "pr") {
          if (!orgArg) {
            cmdCtx.log.error("Usage: wopr github pr owner/repo#123");
            return;
          }
          const ref = parseRef(orgArg);
          if (!ref) {
            cmdCtx.log.error("Invalid format. Use: owner/repo#123");
            return;
          }
          const pr = viewPr(ref.repo, ref.num);
          if (pr) {
            cmdCtx.log.info(formatSummary(pr));
          } else {
            const ghResult = execGh(["pr", "view", String(ref.num), "--repo", ref.repo, "--json", "number"]);
            const detail = ghResult.success ? "" : `: ${ghResult.stdout}`;
            cmdCtx.log.error(`Could not fetch PR ${ref.repo}#${ref.num}${detail}`);
          }
          return;
        }

        if (subcommand === "issue") {
          if (!orgArg) {
            cmdCtx.log.error("Usage: wopr github issue owner/repo#123");
            return;
          }
          const ref = parseRef(orgArg);
          if (!ref) {
            cmdCtx.log.error("Invalid format. Use: owner/repo#123");
            return;
          }
          const issue = viewIssue(ref.repo, ref.num);
          if (issue) {
            cmdCtx.log.info(formatSummary(issue));
          } else {
            const ghResult = execGh(["issue", "view", String(ref.num), "--repo", ref.repo, "--json", "number"]);
            const detail = ghResult.success ? "" : `: ${ghResult.stdout}`;
            cmdCtx.log.error(`Could not fetch issue ${ref.repo}#${ref.num}${detail}`);
          }
          return;
        }

        if (subcommand === "url") {
          const url = await getWebhookUrl();
          if (url) {
            cmdCtx.log.info(`Webhook URL: ${url}`);
          } else {
            cmdCtx.log.error("Webhook URL not available. Check funnel and webhooks plugins.");
          }
          return;
        }

        cmdCtx.log.info("Usage: wopr github <setup|status|pr|issue|webhook|url> [arg]");
        cmdCtx.log.info("");
        cmdCtx.log.info("Commands:");
        cmdCtx.log.info("  status              - Show GitHub integration status");
        cmdCtx.log.info("  setup [org]         - Set up webhooks for configured orgs");
        cmdCtx.log.info("  webhook [org]       - Alias for setup");
        cmdCtx.log.info("  pr owner/repo#123   - View pull request details");
        cmdCtx.log.info("  issue owner/repo#123 - View issue details");
        cmdCtx.log.info("  url                 - Show webhook URL");
      },
    },
  ],

  async init(pluginCtx) {
    ctx = pluginCtx;
    const config = ctx.getConfig<GitHubConfig>();

    // Register extension
    ctx.registerExtension("github", githubExtension);

    // Check gh CLI availability
    const ghAvailable = exec("which gh").success;
    if (!ghAvailable) {
      ctx.log.warn("GitHub CLI (gh) not found. Install: brew install gh (macOS) or apt install gh (Debian)");
    } else {
      const authed = await checkGhAuth();
      if (!authed) {
        ctx.log.warn("GitHub CLI not authenticated - run 'gh auth login'");
      } else {
        ctx.log.info("GitHub CLI authenticated");
      }
    }

    // Log configured orgs
    if (config?.orgs?.length) {
      ctx.log.info(`GitHub plugin initialized for orgs: ${config.orgs.join(", ")}`);
    } else {
      ctx.log.info("GitHub plugin initialized (no orgs configured)");
    }
  },

  async shutdown() {
    ctx?.unregisterExtension("github");
    ctx = null;
  },
};

export default plugin;
export type { GitHubExtension, GitHubItemSummary, WebhookEvent, WebhookRouteResult };

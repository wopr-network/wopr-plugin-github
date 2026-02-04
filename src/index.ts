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
  WebhookSetupResult,
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

  // Check if webhook already exists
  const listResult = exec(`gh api orgs/${org}/hooks --jq '.[] | select(.config.url == "${webhookUrl}") | .id'`);
  if (listResult.success && listResult.stdout) {
    const existingId = parseInt(listResult.stdout, 10);
    ctx?.log.info(`Webhook already exists for ${org}: ID ${existingId}`);
    return { success: true, webhookUrl, webhookId: existingId };
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
  ctx?.log.info(`Created webhook for ${org}: ID ${webhookId}`);

  return { success: true, webhookUrl, webhookId };
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
    ],
  },

  commands: [
    {
      name: "github",
      description: "GitHub integration commands",
      usage: "wopr github <setup|status|webhook> [org]",
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

        if (subcommand === "url") {
          const url = await getWebhookUrl();
          if (url) {
            cmdCtx.log.info(`Webhook URL: ${url}`);
          } else {
            cmdCtx.log.error("Webhook URL not available. Check funnel and webhooks plugins.");
          }
          return;
        }

        cmdCtx.log.info("Usage: wopr github <setup|status|url> [org]");
        cmdCtx.log.info("");
        cmdCtx.log.info("Commands:");
        cmdCtx.log.info("  status   - Show GitHub integration status");
        cmdCtx.log.info("  setup    - Set up webhooks for configured orgs");
        cmdCtx.log.info("  url      - Show webhook URL");
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
export type { GitHubExtension };

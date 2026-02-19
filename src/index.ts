/**
 * WOPR GitHub Plugin
 *
 * Orchestrates GitHub integration:
 * - Sets up org webhooks via gh CLI
 * - Uses funnel extension for public URL
 * - Uses webhooks extension for routing config
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WOPRPluginContext } from "@wopr-network/plugin-types";
import type { PluginContextWithStorage, PluginStorageAPI } from "./storage.js";
import { SUBSCRIPTIONS_SCHEMA, SUBSCRIPTIONS_TABLE } from "./storage.js";
import type {
	CustomEventEmitter,
	FunnelExtension,
	GitHubConfig,
	GitHubExtension,
	GitHubItemSummary,
	GitHubStatusInfo,
	RecentActivityItem,
	RepoSubscription,
	WatchedRepoInfo,
	WebhookEvent,
	WebhookRouteResult,
	WebhookSetupResult,
	WebhooksExtension,
	WOPRPluginWithConfig,
} from "./types.js";

// ============================================================================
// Event listener references (for cleanup on shutdown)
// ============================================================================

let webhooksReadyHandler: ((...args: any[]) => void) | null = null;
let hostnameChangedHandler: ((...args: any[]) => void) | null = null;

// ============================================================================
// State
// ============================================================================

let ctx: WOPRPluginContext | null = null;

/**
 * Reference to the Storage API when available.
 * Set during init() if ctx.storage is present on the plugin context.
 */
let storage: PluginStorageAPI | null = null;

/**
 * Path to the legacy subscriptions JSON file (used only for one-time migration).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_PATH = join(__dirname, "..", "data", "subscriptions.json");

// ============================================================================
// Helpers
// ============================================================================

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
		return {
			stdout: (result.stderr || result.stdout || "").trim(),
			success: false,
		};
	} catch (err: any) {
		return { stdout: err.message || "", success: false };
	}
}

async function checkGhAuth(): Promise<boolean> {
	const result = execGh(["auth", "status"]);
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
	if (!validateOrg(org)) {
		return {
			success: false,
			error: `Invalid org name: "${org}". Only alphanumeric characters, hyphens, dots, and underscores are allowed.`,
		};
	}

	// Check gh auth
	if (!(await checkGhAuth())) {
		return {
			success: false,
			error: "gh CLI not authenticated. Run 'gh auth login' first.",
		};
	}

	// Get webhook URL
	const webhookUrl = await getWebhookUrl();
	if (!webhookUrl) {
		return {
			success: false,
			error:
				"No webhook URL available. Ensure tailscale-funnel and webhooks plugins are configured.",
		};
	}

	// Get webhook secret from webhooks config
	const webhooks = getWebhooksExtension();
	const webhooksConfig = webhooks?.getConfig();
	if (!webhooksConfig?.token) {
		return { success: false, error: "No webhook token configured" };
	}

	// Check if webhook already exists with the exact URL
	const existingExact = findOrgWebhookByUrl(org, webhookUrl);
	if (existingExact) {
		ctx?.log.info(`Webhook already exists for ${org}: ID ${existingExact}`);
		return { success: true, webhookUrl, webhookId: existingExact };
	}

	// Check for stale webhook (same basePath, different hostname) and update it
	const stale = findAnyOrgWebhook(org, webhooksConfig.basePath);
	if (stale) {
		ctx?.log.info(
			`Found stale webhook ${stale.id} for ${org} (URL: ${stale.url}), updating to ${webhookUrl}`,
		);
		const patchArgs = [
			"api",
			`orgs/${org}/hooks/${stale.id}`,
			"-X",
			"PATCH",
			"-f",
			`config[url]=${webhookUrl}`,
			"-f",
			"config[content_type]=json",
			"--jq",
			".id",
		];
		const patchResult = execGh(patchArgs);
		if (patchResult.success) {
			const patchedId = parseInt(patchResult.stdout, 10);
			return {
				success: true,
				webhookUrl,
				webhookId: Number.isNaN(patchedId) ? stale.id : patchedId,
			};
		}
		ctx?.log.warn(
			`Failed to update stale webhook ${stale.id}, creating new one`,
		);
	}

	// Create webhook using gh api
	// Build args array to avoid shell escaping issues with secret
	const createArgs = [
		"api",
		`orgs/${org}/hooks`,
		"-X",
		"POST",
		"-f",
		"name=web",
		"-f",
		"active=true",
		"-f",
		`config[url]=${webhookUrl}`,
		"-f",
		"config[content_type]=json",
		"-f",
		`config[secret]=${webhooksConfig.token}`,
		"-f",
		"events[]=pull_request",
		"-f",
		"events[]=pull_request_review",
		"--jq",
		".id",
	];

	const createResult = execGh(createArgs);
	if (!createResult.success) {
		return {
			success: false,
			error: `Failed to create webhook: ${createResult.stdout}`,
		};
	}

	const webhookId = parseInt(createResult.stdout, 10);
	if (Number.isNaN(webhookId)) {
		return {
			success: false,
			error: `Invalid webhook ID returned: ${createResult.stdout}`,
		};
	}
	ctx?.log.info(`Created webhook for ${org}: ID ${webhookId}`);

	return { success: true, webhookUrl, webhookId };
}

/**
 * Find an org webhook by its config URL. Returns the hook ID or null.
 */
function findOrgWebhookByUrl(org: string, url: string): number | null {
	if (!validateOrg(org)) return null;
	const listArgs = [
		"api",
		`orgs/${org}/hooks`,
		"--jq",
		".[] | .id,.config.url",
	];
	const listResult = execGh(listArgs);
	if (listResult.success && listResult.stdout) {
		const lines = listResult.stdout.split("\n");
		for (let i = 0; i < lines.length - 1; i += 2) {
			const id = parseInt(lines[i], 10);
			if (!Number.isNaN(id) && lines[i + 1] === url) return id;
		}
	}
	return null;
}

/**
 * Find any org webhook whose URL contains our basePath suffix (/github).
 * Used for idempotent setup -- detect webhooks with stale hostnames.
 */
function findAnyOrgWebhook(
	org: string,
	basePath: string,
): { id: number; url: string } | null {
	if (!validateOrg(org)) return null;
	const suffix = `${basePath}/github`;
	const listArgs = [
		"api",
		`orgs/${org}/hooks`,
		"--jq",
		".[] | .id,.config.url",
	];
	const listResult = execGh(listArgs);
	if (listResult.success && listResult.stdout) {
		const lines = listResult.stdout.split("\n");
		for (let i = 0; i < lines.length - 1; i += 2) {
			const id = parseInt(lines[i], 10);
			const hookUrl = lines[i + 1];
			if (!Number.isNaN(id) && hookUrl && hookUrl.endsWith(suffix)) {
				return { id, url: hookUrl };
			}
		}
	}
	return null;
}

/**
 * Update an existing org-level webhook with a new URL (PATCH).
 */
async function updateOrgWebhook(
	org: string,
	oldHostname: string,
	newHostname: string,
): Promise<WebhookSetupResult> {
	if (!validateOrg(org)) {
		return {
			success: false,
			error: `Invalid org name: "${org}". Only alphanumeric characters, hyphens, dots, and underscores are allowed.`,
		};
	}

	if (!(await checkGhAuth())) {
		return {
			success: false,
			error: "gh CLI not authenticated. Run 'gh auth login' first.",
		};
	}

	const webhooks = getWebhooksExtension();
	const webhooksConfig = webhooks?.getConfig();
	if (!webhooksConfig) {
		return { success: false, error: "Webhooks extension not configured" };
	}

	const oldUrl = `https://${oldHostname}${webhooksConfig.basePath}/github`;
	const newUrl = `https://${newHostname}${webhooksConfig.basePath}/github`;

	// Check if webhook was already updated to newUrl (idempotent for repeat events)
	const alreadyUpdated = findOrgWebhookByUrl(org, newUrl);
	if (alreadyUpdated) {
		ctx?.log.info(
			`Webhook ${alreadyUpdated} for ${org} already points to ${newUrl}`,
		);
		return { success: true, webhookUrl: newUrl, webhookId: alreadyUpdated };
	}

	const hookId = findOrgWebhookByUrl(org, oldUrl);
	if (!hookId) {
		return {
			success: false,
			error: `No existing webhook found for ${org} with URL ${oldUrl}`,
		};
	}

	const patchArgs = [
		"api",
		`orgs/${org}/hooks/${hookId}`,
		"-X",
		"PATCH",
		"-f",
		`config[url]=${newUrl}`,
		"-f",
		"config[content_type]=json",
		"--jq",
		".id",
	];
	const patchResult = execGh(patchArgs);
	if (!patchResult.success) {
		return {
			success: false,
			error: `Failed to update webhook ${hookId}: ${patchResult.stdout}`,
		};
	}

	ctx?.log.info(`Updated webhook ${hookId} for ${org}: ${oldUrl} -> ${newUrl}`);
	return { success: true, webhookUrl: newUrl, webhookId: hookId };
}

/**
 * Find a repo-level webhook by URL. Returns the hook ID or null.
 */
function findRepoWebhookByUrl(repo: string, url: string): number | null {
	const listArgs = [
		"api",
		`repos/${repo}/hooks`,
		"--jq",
		".[] | .id,.config.url",
	];
	const listResult = execGh(listArgs);
	if (listResult.success && listResult.stdout) {
		const lines = listResult.stdout.split("\n");
		for (let i = 0; i < lines.length - 1; i += 2) {
			const id = parseInt(lines[i], 10);
			if (!Number.isNaN(id) && lines[i + 1] === url) return id;
		}
	}
	return null;
}

/**
 * Update a repo-level webhook with a new URL (PATCH).
 */
async function updateRepoWebhook(
	repo: string,
	oldHostname: string,
	newHostname: string,
): Promise<WebhookSetupResult> {
	const webhooks = getWebhooksExtension();
	const webhooksConfig = webhooks?.getConfig();
	if (!webhooksConfig) {
		return { success: false, error: "Webhooks extension not configured" };
	}

	const oldUrl = `https://${oldHostname}${webhooksConfig.basePath}/github`;
	const newUrl = `https://${newHostname}${webhooksConfig.basePath}/github`;

	// Check if webhook was already updated to newUrl (idempotent for repeat events)
	const alreadyUpdated = findRepoWebhookByUrl(repo, newUrl);
	if (alreadyUpdated) {
		ctx?.log.info(
			`Repo webhook ${alreadyUpdated} for ${repo} already points to ${newUrl}`,
		);
		return { success: true, webhookUrl: newUrl, webhookId: alreadyUpdated };
	}

	const hookId = findRepoWebhookByUrl(repo, oldUrl);
	if (!hookId) {
		return {
			success: false,
			error: `No existing webhook found for ${repo} with URL ${oldUrl}`,
		};
	}

	const patchArgs = [
		"api",
		`repos/${repo}/hooks/${hookId}`,
		"-X",
		"PATCH",
		"-f",
		`config[url]=${newUrl}`,
		"-f",
		"config[content_type]=json",
		"--jq",
		".id",
	];
	const patchResult = execGh(patchArgs);
	if (!patchResult.success) {
		return {
			success: false,
			error: `Failed to update repo webhook ${hookId}: ${patchResult.stdout}`,
		};
	}

	// Update the in-memory subscription's webhookId if it changed (it shouldn't, but be safe)
	const sub = subscriptions.get(repo);
	if (sub) {
		sub.webhookId = hookId;
		await persistSubscription(sub);
	}

	ctx?.log.info(
		`Updated repo webhook ${hookId} for ${repo}: ${oldUrl} -> ${newUrl}`,
	);
	return { success: true, webhookUrl: newUrl, webhookId: hookId };
}

// ============================================================================
// Repo-Level Webhook Subscriptions
// ============================================================================

const DEFAULT_REPO_EVENTS = [
	"push",
	"pull_request",
	"pull_request_review",
	"issues",
	"issue_comment",
];

/**
 * In-memory subscription cache, loaded from disk on init.
 * Keyed by "owner/repo".
 */
const subscriptions = new Map<string, RepoSubscription>();

/**
 * Persist a single subscription to the Storage API (SQL).
 * Falls back silently if storage is unavailable.
 */
async function persistSubscription(sub: RepoSubscription): Promise<void> {
	if (!storage) return;
	try {
		await storage.put(SUBSCRIPTIONS_TABLE, sub.repo, sub);
		ctx?.log.debug?.(`Persisted subscription for ${sub.repo} to storage`);
	} catch (err: any) {
		ctx?.log.warn(
			`Failed to persist subscription for ${sub.repo}: ${err.message}`,
		);
	}
}

/**
 * Remove a single subscription from the Storage API (SQL).
 * Falls back silently if storage is unavailable.
 */
async function removeSubscription(repo: string): Promise<void> {
	if (!storage) return;
	try {
		await storage.delete(SUBSCRIPTIONS_TABLE, repo);
		ctx?.log.debug?.(`Removed subscription for ${repo} from storage`);
	} catch (err: any) {
		ctx?.log.warn(`Failed to remove subscription for ${repo}: ${err.message}`);
	}
}

/**
 * Load subscriptions from the Storage API (SQL), with migration from
 * the legacy subscriptions.json file and a fallback to config.
 *
 * Priority order:
 * 1. Migrate from subscriptions.json if it exists (one-time, then deletes file)
 * 2. Load from SQL storage
 * 3. Fall back to config-embedded subscriptions (first-time setup)
 */
async function loadSubscriptions(): Promise<void> {
	subscriptions.clear();

	// Step 1: Migrate from legacy subscriptions.json if it exists
	if (existsSync(SUBSCRIPTIONS_PATH)) {
		try {
			const raw = readFileSync(SUBSCRIPTIONS_PATH, "utf-8");
			const obj = JSON.parse(raw) as Record<string, RepoSubscription>;
			for (const [repo, sub] of Object.entries(obj)) {
				subscriptions.set(repo, sub);
			}
			ctx?.log.info(
				`Migrating ${subscriptions.size} subscription(s) from subscriptions.json to Storage API`,
			);
			// Persist each migrated subscription to storage
			for (const sub of subscriptions.values()) {
				await persistSubscription(sub);
			}
			// Delete the legacy file after successful migration
			try {
				unlinkSync(SUBSCRIPTIONS_PATH);
				ctx?.log.info("Deleted legacy subscriptions.json after migration");
			} catch (err: any) {
				ctx?.log.warn(
					`Failed to delete legacy subscriptions.json: ${err.message}`,
				);
			}
			return;
		} catch {
			// File unreadable or invalid JSON — fall through
		}
	}

	// Step 2: Load from SQL storage
	if (storage) {
		try {
			const rows = await storage.list(SUBSCRIPTIONS_TABLE);
			for (const row of rows) {
				const sub = row as RepoSubscription;
				if (sub?.repo) {
					subscriptions.set(sub.repo, sub);
				}
			}
			if (subscriptions.size > 0) {
				return;
			}
		} catch (err: any) {
			ctx?.log.warn(
				`Failed to load subscriptions from storage: ${err.message}`,
			);
		}
	}

	// Step 3: Fall back to config-embedded subscriptions (first-time setup)
	const config = ctx?.getConfig<GitHubConfig>();
	if (config?.subscriptions) {
		for (const [repo, sub] of Object.entries(config.subscriptions)) {
			subscriptions.set(repo, sub);
		}
		// Persist config subscriptions to storage for future runs
		if (subscriptions.size > 0) {
			for (const sub of subscriptions.values()) {
				await persistSubscription(sub);
			}
		}
	}
}

/**
 * Validate GitHub org name: alphanumeric, hyphens, dots, underscores. Max 39 chars.
 * Must start/end with alphanumeric. No path traversal characters.
 * Prevents path traversal in API paths like `orgs/${org}/hooks`.
 */
const GITHUB_ORG_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,37}[a-zA-Z0-9])?$/;

function validateOrg(org: string): boolean {
	return GITHUB_ORG_REGEX.test(org);
}

/**
 * Validate "owner/repo" format.
 */
function isValidRepo(repo: string): boolean {
	return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo);
}

async function subscribeRepo(
	repo: string,
	options?: { events?: string[]; session?: string },
): Promise<WebhookSetupResult> {
	if (!isValidRepo(repo)) {
		return {
			success: false,
			error: `Invalid repo format: "${repo}". Use owner/repo`,
		};
	}

	if (!(await checkGhAuth())) {
		return {
			success: false,
			error: "gh CLI not authenticated. Run 'gh auth login' first.",
		};
	}

	// Already subscribed?
	const existing = subscriptions.get(repo);
	if (existing) {
		return {
			success: false,
			error: `Already subscribed to ${repo} (webhook ID: ${existing.webhookId}). Unsubscribe first to change settings.`,
		};
	}

	const webhookUrl = await getWebhookUrl();
	if (!webhookUrl) {
		return {
			success: false,
			error:
				"No webhook URL available. Ensure tailscale-funnel and webhooks plugins are configured.",
		};
	}

	const webhooks = getWebhooksExtension();
	const webhooksConfig = webhooks?.getConfig();
	if (!webhooksConfig?.token) {
		return { success: false, error: "No webhook token configured" };
	}

	const events = options?.events ?? DEFAULT_REPO_EVENTS;

	// Check if webhook already exists on this repo pointing to our URL
	const existingId = findRepoWebhookByUrl(repo, webhookUrl);
	if (existingId) {
		// Webhook exists on GitHub but not in our tracking -- adopt it
		const sub: RepoSubscription = {
			repo,
			webhookId: existingId,
			events,
			session: options?.session,
			createdAt: new Date().toISOString(),
		};
		subscriptions.set(repo, sub);
		await persistSubscription(sub);
		ctx?.log.info(`Adopted existing webhook for ${repo}: ID ${existingId}`);
		return { success: true, webhookUrl, webhookId: existingId };
	}

	// Create repo-level webhook
	const createArgs = [
		"api",
		`repos/${repo}/hooks`,
		"-X",
		"POST",
		"-f",
		"name=web",
		"-f",
		"active=true",
		"-f",
		`config[url]=${webhookUrl}`,
		"-f",
		"config[content_type]=json",
		"-f",
		`config[secret]=${webhooksConfig.token}`,
	];
	for (const event of events) {
		createArgs.push("-f", `events[]=${event}`);
	}
	createArgs.push("--jq", ".id");

	const createResult = execGh(createArgs);
	if (!createResult.success) {
		return {
			success: false,
			error: `Failed to create webhook: ${createResult.stdout}`,
		};
	}

	const webhookId = parseInt(createResult.stdout, 10);
	if (Number.isNaN(webhookId)) {
		return {
			success: false,
			error: `Invalid webhook ID returned: ${createResult.stdout}`,
		};
	}

	const sub: RepoSubscription = {
		repo,
		webhookId,
		events,
		session: options?.session,
		createdAt: new Date().toISOString(),
	};
	subscriptions.set(repo, sub);
	await persistSubscription(sub);
	ctx?.log.info(`Subscribed to ${repo}: webhook ID ${webhookId}`);
	return { success: true, webhookUrl, webhookId };
}

async function unsubscribeRepo(
	repo: string,
): Promise<{ success: boolean; error?: string }> {
	const sub = subscriptions.get(repo);
	if (!sub) {
		return { success: false, error: `Not subscribed to ${repo}` };
	}

	if (!(await checkGhAuth())) {
		return {
			success: false,
			error: "gh CLI not authenticated. Run 'gh auth login' first.",
		};
	}

	// Delete the webhook from GitHub
	const deleteArgs = [
		"api",
		`repos/${repo}/hooks/${sub.webhookId}`,
		"-X",
		"DELETE",
	];
	const deleteResult = execGh(deleteArgs);
	if (!deleteResult.success) {
		// If 404, webhook was already removed -- that's fine
		if (
			!deleteResult.stdout.includes("Not Found") &&
			!deleteResult.stdout.includes("404")
		) {
			return {
				success: false,
				error: `Failed to delete webhook: ${deleteResult.stdout}`,
			};
		}
	}

	subscriptions.delete(repo);
	await removeSubscription(repo);
	ctx?.log.info(`Unsubscribed from ${repo} (webhook ID ${sub.webhookId})`);
	return { success: true };
}

// ============================================================================
// Event Routing
// ============================================================================

/**
 * Resolve which session an event type should route to.
 *
 * Priority:
 * 1. Repo-level subscription session override (if repo provided)
 * 2. Exact match in routing table (e.g. "pull_request" -> "code-review")
 * 3. Wildcard "*" in routing table
 * 4. Legacy prReviewSession / releaseSession fields
 * 5. null (no route configured)
 */
function resolveSessionFromConfig(
	eventType: string,
	repo?: string,
): string | null {
	// 0. Check repo-level subscription session override
	if (repo) {
		const sub = subscriptions.get(repo);
		if (sub?.session) {
			return sub.session;
		}
	}

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
	return `${oneLine.slice(0, maxLen - 3)}...`;
}

const PR_JSON_FIELDS = [
	"number",
	"title",
	"state",
	"author",
	"labels",
	"body",
	"url",
	"createdAt",
	"updatedAt",
	"mergeable",
	"reviewDecision",
	"additions",
	"deletions",
	"headRefName",
	"baseRefName",
].join(",");

const ISSUE_JSON_FIELDS = [
	"number",
	"title",
	"state",
	"author",
	"labels",
	"body",
	"url",
	"createdAt",
	"updatedAt",
].join(",");

function viewPr(repo: string, num: number): GitHubItemSummary | null {
	const result = execGh([
		"pr",
		"view",
		String(num),
		"--repo",
		repo,
		"--json",
		PR_JSON_FIELDS,
	]);
	if (!result.success) {
		ctx?.log.debug?.(
			`[github] Failed to fetch PR ${repo}#${num}: ${result.stdout}`,
		);
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
	const result = execGh([
		"issue",
		"view",
		String(num),
		"--repo",
		repo,
		"--json",
		ISSUE_JSON_FIELDS,
	]);
	if (!result.success) {
		ctx?.log.debug?.(
			`[github] Failed to fetch issue ${repo}#${num}: ${result.stdout}`,
		);
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
		ctx?.log.debug?.(
			`[github] Failed to parse issue response for ${repo}#${num}`,
		);
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
			lines.push(
				`  Changes: +${item.additions || 0} / -${item.deletions || 0}`,
			);
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

	async updateWebhook(org: string, oldHostname: string, newHostname: string) {
		return updateOrgWebhook(org, oldHostname, newHostname);
	},

	async getWebhookUrl() {
		return getWebhookUrl();
	},

	async isAuthenticated() {
		return checkGhAuth();
	},

	handleWebhook(event: WebhookEvent): WebhookRouteResult {
		const { eventType, deliveryId, payload } = event;

		if (!eventType) {
			return { routed: false, reason: "Missing event type" };
		}

		// Extract repo from payload for subscription-level routing
		const repository = payload.repository as
			| Record<string, unknown>
			| undefined;
		const repo =
			typeof repository?.full_name === "string"
				? repository.full_name
				: undefined;

		const session = resolveSessionFromConfig(eventType, repo);
		if (!session) {
			ctx?.log.debug?.(
				`[github] No route for event type: ${eventType} (delivery: ${deliveryId || "unknown"})`,
			);
			return {
				routed: false,
				reason: `No session configured for event type: ${eventType}`,
			};
		}

		ctx?.log.info(
			`[github] Routing ${eventType} -> session "${session}" (delivery: ${deliveryId || "unknown"})`,
		);
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

	async subscribe(
		repo: string,
		options?: { events?: string[]; session?: string },
	) {
		return subscribeRepo(repo, options);
	},

	async unsubscribe(repo: string) {
		return unsubscribeRepo(repo);
	},

	listSubscriptions(): RepoSubscription[] {
		return Array.from(subscriptions.values());
	},

	async getStatus(): Promise<GitHubStatusInfo> {
		const authenticated = await checkGhAuth();
		let username = "unknown";
		if (authenticated) {
			const result = execGh(["api", "user", "--jq", ".login"]);
			if (result.success && result.stdout) {
				username = result.stdout;
			}
		}
		const config = ctx?.getConfig<GitHubConfig>();
		const webhookUrl = await getWebhookUrl();
		return {
			authenticated,
			username,
			orgs: config?.orgs ?? [],
			webhookUrl,
			subscriptionCount: subscriptions.size,
		};
	},

	listWatchedRepos(): WatchedRepoInfo[] {
		return Array.from(subscriptions.values()).map((sub) => ({
			repo: sub.repo,
			webhookId: sub.webhookId,
			events: sub.events,
			session: sub.session ?? null,
			createdAt: sub.createdAt,
		}));
	},

	getRecentActivity(repo?: string, limit = 10): RecentActivityItem[] {
		const items: RecentActivityItem[] = [];
		const repos = repo ? [repo] : Array.from(subscriptions.keys());

		if (repos.length === 0) return items;

		for (const r of repos) {
			if (!isValidRepo(r)) continue;

			// Fetch recent PRs
			const prResult = execGh([
				"pr",
				"list",
				"--repo",
				r,
				"--limit",
				String(Math.min(limit, 20)),
				"--state",
				"all",
				"--json",
				"number,title,state,author,url,updatedAt",
			]);
			if (prResult.success && prResult.stdout) {
				try {
					const prs = JSON.parse(prResult.stdout) as Array<{
						number: number;
						title: string;
						state: string;
						author: { login: string };
						url: string;
						updatedAt: string;
					}>;
					for (const pr of prs) {
						items.push({
							type: "pr",
							repo: r,
							number: pr.number,
							title: pr.title,
							state: pr.state,
							author: pr.author?.login || "unknown",
							url: pr.url,
							updatedAt: pr.updatedAt,
						});
					}
				} catch {
					// ignore parse errors
				}
			}

			// Fetch recent issues
			const issueResult = execGh([
				"issue",
				"list",
				"--repo",
				r,
				"--limit",
				String(Math.min(limit, 20)),
				"--state",
				"all",
				"--json",
				"number,title,state,author,url,updatedAt",
			]);
			if (issueResult.success && issueResult.stdout) {
				try {
					const issues = JSON.parse(issueResult.stdout) as Array<{
						number: number;
						title: string;
						state: string;
						author: { login: string };
						url: string;
						updatedAt: string;
					}>;
					for (const issue of issues) {
						items.push({
							type: "issue",
							repo: r,
							number: issue.number,
							title: issue.title,
							state: issue.state,
							author: issue.author?.login || "unknown",
							url: issue.url,
							updatedAt: issue.updatedAt,
						});
					}
				} catch {
					// ignore parse errors
				}
			}

			// Stop if we have enough items
			if (items.length >= limit) break;
		}

		// Sort by updatedAt descending and limit
		items.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
		return items.slice(0, limit);
	},
};

// ============================================================================
// Plugin
// ============================================================================

const plugin: WOPRPluginWithConfig = {
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
				type: "text",
				label: "PR Review Session",
				description: "Session to route PR events to",
				default:
					"discord:misfits:#pay-no-attention-to-the-man-behind-the-curtain",
			},
			{
				name: "releaseSession",
				type: "text",
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
			usage:
				"wopr github <setup|status|subscribe|unsubscribe|subscriptions|pr|issue|webhook|url> [arg]",
			async handler(cmdCtx, args) {
				const [subcommand, orgArg] = args;

				if (subcommand === "status") {
					const authed = await checkGhAuth();
					cmdCtx.log.info(
						`GitHub CLI: ${authed ? "authenticated" : "not authenticated"}`,
					);

					const webhookUrl = await getWebhookUrl();
					cmdCtx.log.info(`Webhook URL: ${webhookUrl || "not available"}`);

					const config = cmdCtx.getConfig<GitHubConfig>();
					if (config?.orgs?.length) {
						cmdCtx.log.info(`Configured orgs: ${config.orgs.join(", ")}`);

						// Per-org webhook status
						if (authed && webhookUrl) {
							const webhooks = getWebhooksExtension();
							const webhooksConfig = webhooks?.getConfig();
							for (const org of config.orgs) {
								const exact = findOrgWebhookByUrl(org, webhookUrl);
								if (exact) {
									cmdCtx.log.info(`  ${org}: webhook ${exact} (URL matches)`);
								} else if (webhooksConfig) {
									const stale = findAnyOrgWebhook(org, webhooksConfig.basePath);
									if (stale) {
										cmdCtx.log.info(
											`  ${org}: webhook ${stale.id} (URL MISMATCH: ${stale.url})`,
										);
									} else {
										cmdCtx.log.info(`  ${org}: no webhook configured`);
									}
								} else {
									cmdCtx.log.info(
										`  ${org}: webhooks extension not configured`,
									);
								}
							}
						}
					}

					const subCount = subscriptions.size;
					cmdCtx.log.info(`Repo subscriptions: ${subCount}`);
					if (subCount > 0) {
						for (const sub of subscriptions.values()) {
							cmdCtx.log.info(`  ${sub.repo} (webhook ${sub.webhookId})`);
						}
					}
					return;
				}

				if (subcommand === "setup" || subcommand === "webhook") {
					const config = cmdCtx.getConfig<GitHubConfig>();
					const orgs = orgArg ? [orgArg] : config?.orgs || [];

					if (orgs.length === 0) {
						cmdCtx.log.error(
							"No org specified. Usage: wopr github setup <org>",
						);
						return;
					}

					for (const org of orgs) {
						if (!validateOrg(org)) {
							cmdCtx.log.error(
								`Invalid org name: "${org}". Only alphanumeric characters, hyphens, dots, and underscores are allowed.`,
							);
							continue;
						}
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
						const ghResult = execGh([
							"pr",
							"view",
							String(ref.num),
							"--repo",
							ref.repo,
							"--json",
							"number",
						]);
						const detail = ghResult.success ? "" : `: ${ghResult.stdout}`;
						cmdCtx.log.error(
							`Could not fetch PR ${ref.repo}#${ref.num}${detail}`,
						);
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
						const ghResult = execGh([
							"issue",
							"view",
							String(ref.num),
							"--repo",
							ref.repo,
							"--json",
							"number",
						]);
						const detail = ghResult.success ? "" : `: ${ghResult.stdout}`;
						cmdCtx.log.error(
							`Could not fetch issue ${ref.repo}#${ref.num}${detail}`,
						);
					}
					return;
				}

				if (subcommand === "url") {
					const url = await getWebhookUrl();
					if (url) {
						cmdCtx.log.info(`Webhook URL: ${url}`);
					} else {
						cmdCtx.log.error(
							"Webhook URL not available. Check funnel and webhooks plugins.",
						);
					}
					return;
				}

				if (subcommand === "subscribe") {
					if (!orgArg) {
						cmdCtx.log.error(
							"Usage: wopr github subscribe owner/repo [--events push,pull_request] [--session session-name]",
						);
						return;
					}

					// Parse optional flags from remaining args
					let events: string[] | undefined;
					let session: string | undefined;
					for (let i = 1; i < args.length; i++) {
						if (args[i] === "--events" && args[i + 1]) {
							events = args[i + 1].split(",").map((e) => e.trim());
							i++;
						} else if (args[i] === "--session" && args[i + 1]) {
							session = args[i + 1];
							i++;
						}
					}

					cmdCtx.log.info(`Subscribing to ${orgArg}...`);
					const result = await subscribeRepo(orgArg, { events, session });
					if (result.success) {
						cmdCtx.log.info(`Subscribed to ${orgArg}`);
						cmdCtx.log.info(`  Webhook URL: ${result.webhookUrl}`);
						cmdCtx.log.info(`  Webhook ID: ${result.webhookId}`);
					} else {
						cmdCtx.log.error(`Failed: ${result.error}`);
					}
					return;
				}

				if (subcommand === "unsubscribe") {
					if (!orgArg) {
						cmdCtx.log.error("Usage: wopr github unsubscribe owner/repo");
						return;
					}

					cmdCtx.log.info(`Unsubscribing from ${orgArg}...`);
					const result = await unsubscribeRepo(orgArg);
					if (result.success) {
						cmdCtx.log.info(`Unsubscribed from ${orgArg}`);
					} else {
						cmdCtx.log.error(`Failed: ${result.error}`);
					}
					return;
				}

				if (subcommand === "subscriptions") {
					const subs = Array.from(subscriptions.values());
					if (subs.length === 0) {
						cmdCtx.log.info("No repo subscriptions active.");
						return;
					}
					cmdCtx.log.info(`Active subscriptions (${subs.length}):`);
					for (const sub of subs) {
						const sessionInfo = sub.session ? ` -> ${sub.session}` : "";
						cmdCtx.log.info(
							`  ${sub.repo} (webhook ${sub.webhookId})${sessionInfo}`,
						);
						cmdCtx.log.info(`    Events: ${sub.events.join(", ")}`);
						cmdCtx.log.info(`    Since: ${sub.createdAt}`);
					}
					return;
				}

				cmdCtx.log.info("Usage: wopr github <command> [arg]");
				cmdCtx.log.info("");
				cmdCtx.log.info("Commands:");
				cmdCtx.log.info(
					"  status                  - Show GitHub integration status",
				);
				cmdCtx.log.info(
					"  setup [org]             - Set up org-level webhooks",
				);
				cmdCtx.log.info("  webhook [org]           - Alias for setup");
				cmdCtx.log.info(
					"  subscribe owner/repo    - Subscribe to repo webhook events",
				);
				cmdCtx.log.info(
					"  unsubscribe owner/repo  - Unsubscribe from repo webhook events",
				);
				cmdCtx.log.info(
					"  subscriptions           - List active repo subscriptions",
				);
				cmdCtx.log.info(
					"  pr owner/repo#123       - View pull request details",
				);
				cmdCtx.log.info("  issue owner/repo#123    - View issue details");
				cmdCtx.log.info("  url                     - Show webhook URL");
			},
		},
	],

	async init(pluginCtx) {
		ctx = pluginCtx;
		const config = ctx.getConfig<GitHubConfig>();

		// Set up Storage API if available
		const ctxWithStorage = pluginCtx as unknown as PluginContextWithStorage;
		if (ctxWithStorage.storage) {
			storage = ctxWithStorage.storage;
			storage.register(SUBSCRIPTIONS_TABLE, SUBSCRIPTIONS_SCHEMA);
		} else {
			storage = null;
			ctx.log.warn(
				"Storage API not available — subscription persistence is disabled until WOPR daemon provides storage support",
			);
		}

		// Register extension
		ctx.registerExtension("github", githubExtension);

		// Load subscriptions from storage (or migrate from file/config)
		await loadSubscriptions();

		// Check gh CLI availability
		const ghAvailable =
			spawnSync("which", ["gh"], { encoding: "utf-8", timeout: 5000 })
				.status === 0;
		if (!ghAvailable) {
			ctx.log.warn(
				"GitHub CLI (gh) not found. Install: brew install gh (macOS) or apt install gh (Debian)",
			);
		} else {
			const authed = await checkGhAuth();
			if (!authed) {
				ctx.log.warn("GitHub CLI not authenticated - run 'gh auth login'");
			} else {
				ctx.log.info("GitHub CLI authenticated");
			}
		}

		// Subscribe to webhooks:ready — auto-setup org webhooks when infrastructure is available
		// Use pluginCtx (the init parameter) in closures — guaranteed non-null unlike module-level ctx
		if (pluginCtx.events) {
			// Cast to CustomEventEmitter for custom inter-plugin event names
			const events = pluginCtx.events as unknown as CustomEventEmitter;

			// Unsubscribe any existing handlers to prevent leaks if init() called twice
			if (webhooksReadyHandler) {
				events.off("webhooks:ready", webhooksReadyHandler);
				webhooksReadyHandler = null;
			}
			if (hostnameChangedHandler) {
				events.off("funnel:hostname-changed", hostnameChangedHandler);
				hostnameChangedHandler = null;
			}

			webhooksReadyHandler = async () => {
				const url = await getWebhookUrl();
				if (url && config?.orgs?.length) {
					pluginCtx.log.info(
						"webhooks:ready received — auto-setting up org webhooks",
					);
					for (const org of config.orgs) {
						const result = await setupOrgWebhook(org);
						if (result.success) {
							pluginCtx.log.info(
								`Auto-setup webhook for ${org}: ID ${result.webhookId}`,
							);
						} else {
							pluginCtx.log.warn(
								`Auto-setup webhook for ${org} failed: ${result.error}`,
							);
						}
					}
				}
			};
			events.on("webhooks:ready", webhooksReadyHandler);

			// Subscribe to funnel:hostname-changed — update all existing webhooks
			hostnameChangedHandler = async (event: {
				oldHostname: string;
				newHostname: string;
			}) => {
				const { oldHostname, newHostname } = event;
				pluginCtx.log.info(
					`funnel:hostname-changed received: ${oldHostname} -> ${newHostname}`,
				);

				// Update org-level webhooks
				if (config?.orgs?.length) {
					for (const org of config.orgs) {
						const result = await updateOrgWebhook(
							org,
							oldHostname,
							newHostname,
						);
						if (result.success) {
							pluginCtx.log.info(
								`Updated org webhook for ${org}: ${result.webhookUrl}`,
							);
						} else {
							pluginCtx.log.warn(
								`Failed to update org webhook for ${org}: ${result.error}`,
							);
						}
					}
				}

				// Update repo-level webhooks
				for (const [repo] of subscriptions) {
					const result = await updateRepoWebhook(
						repo,
						oldHostname,
						newHostname,
					);
					if (result.success) {
						pluginCtx.log.info(
							`Updated repo webhook for ${repo}: ${result.webhookUrl}`,
						);
					} else {
						pluginCtx.log.warn(
							`Failed to update repo webhook for ${repo}: ${result.error}`,
						);
					}
				}
			};
			events.on("funnel:hostname-changed", hostnameChangedHandler);
		}

		// Log configured orgs
		if (config?.orgs?.length) {
			ctx.log.info(
				`GitHub plugin initialized for orgs: ${config.orgs.join(", ")}`,
			);
		} else {
			ctx.log.info("GitHub plugin initialized (no orgs configured)");
		}

		// Log subscription count
		if (subscriptions.size > 0) {
			ctx.log.info(`Loaded ${subscriptions.size} repo subscription(s)`);
		}
	},

	async shutdown() {
		// Unsubscribe from events
		if (ctx?.events) {
			const events = ctx.events as unknown as CustomEventEmitter;
			if (webhooksReadyHandler) {
				events.off("webhooks:ready", webhooksReadyHandler);
				webhooksReadyHandler = null;
			}
			if (hostnameChangedHandler) {
				events.off("funnel:hostname-changed", hostnameChangedHandler);
				hostnameChangedHandler = null;
			}
		}

		subscriptions.clear();
		storage = null;
		ctx?.unregisterExtension("github");
		ctx = null;
	},
};

export default plugin;
export { validateOrg, setupOrgWebhook };
export type {
	GitHubExtension,
	GitHubItemSummary,
	GitHubStatusInfo,
	RecentActivityItem,
	RepoSubscription,
	WatchedRepoInfo,
	WebhookEvent,
	WebhookRouteResult,
};

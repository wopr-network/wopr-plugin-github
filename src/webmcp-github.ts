/**
 * WebMCP GitHub Tools
 *
 * Registers 3 read-only browser-side WebMCP tools for GitHub integration
 * status, watched repos, and recent activity.
 *
 * These tools call the WOPR daemon REST API via fetch() and are only
 * meaningful when the GitHub plugin is loaded on the instance.
 */

// ============================================================================
// Types (mirrors WebMCPRegistry from wopr-plugin-webui)
// ============================================================================

export interface AuthContext {
	token?: string;
	[key: string]: unknown;
}

export interface ParameterSchema {
	type: string;
	description: string;
	required?: boolean;
}

export interface WebMCPTool {
	name: string;
	description: string;
	parameters: Record<string, ParameterSchema>;
	handler: (
		params: Record<string, unknown>,
		auth: AuthContext,
	) => Promise<unknown>;
}

export interface WebMCPRegistry {
	register(tool: WebMCPTool): void;
	get(name: string): WebMCPTool | undefined;
	list(): string[];
}

// ============================================================================
// Internal helpers
// ============================================================================

interface RequestOptions {
	method?: string;
	body?: string;
	headers?: Record<string, string>;
}

async function daemonRequest<T>(
	apiBase: string,
	path: string,
	auth: AuthContext,
	options?: RequestOptions,
): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...options?.headers,
	};
	if (auth.token) {
		headers.Authorization = `Bearer ${auth.token as string}`;
	}
	const res = await fetch(`${apiBase}${path}`, {
		...options,
		headers,
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: "Request failed" }));
		throw new Error(
			(err as { error?: string }).error || `Request failed (${res.status})`,
		);
	}
	return res.json() as Promise<T>;
}

// ============================================================================
// Tool registration
// ============================================================================

/**
 * Register all 3 GitHub WebMCP tools on the given registry.
 *
 * The tools proxy to the GitHub plugin extension via daemon API endpoints
 * at `/plugins/github/status`, `/plugins/github/repos`, etc.
 *
 * @param registry - The WebMCPRegistry instance to register tools on
 * @param apiBase  - Base URL of the WOPR daemon API (e.g. "/api" or "http://localhost:7437")
 */
export function registerGithubTools(
	registry: WebMCPRegistry,
	apiBase = "/api",
): void {
	// 1. getGithubStatus
	registry.register({
		name: "getGithubStatus",
		description:
			"Get GitHub integration status: authenticated user, connected orgs, webhook URL, and subscription count.",
		parameters: {},
		handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
			return daemonRequest(apiBase, "/plugins/github/status", auth);
		},
	});

	// 2. listWatchedRepos
	registry.register({
		name: "listWatchedRepos",
		description:
			"List repos the bot is monitoring via webhooks, with event types and session routing.",
		parameters: {},
		handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
			return daemonRequest(apiBase, "/plugins/github/repos", auth);
		},
	});

	// 3. getRecentActivity
	registry.register({
		name: "getRecentActivity",
		description:
			"Get recent PRs and issues across watched repos, sorted by most recently updated.",
		parameters: {
			repo: {
				type: "string",
				description:
					"Filter to a specific repo (owner/repo format). If omitted, shows activity across all watched repos.",
				required: false,
			},
			limit: {
				type: "number",
				description:
					"Maximum number of activity items to return (default: 10, max: 50).",
				required: false,
			},
		},
		handler: async (params: Record<string, unknown>, auth: AuthContext) => {
			const query = new URLSearchParams();
			if (params.repo) {
				query.set("repo", String(params.repo));
			}
			if (params.limit) {
				query.set("limit", String(params.limit));
			}
			const qs = query.toString();
			const path = `/plugins/github/activity${qs ? `?${qs}` : ""}`;
			return daemonRequest(apiBase, path, auth);
		},
	});
}

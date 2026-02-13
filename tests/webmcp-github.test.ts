import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AuthContext,
	type WebMCPRegistry,
	registerGithubTools,
} from "../src/webmcp-github.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockJsonResponse(data: unknown, ok = true, status = 200) {
	return {
		ok,
		status,
		json: vi.fn().mockResolvedValue(data),
	};
}

function createRegistry(): WebMCPRegistry {
	const tools = new Map<
		string,
		{ name: string; handler: Function; [k: string]: unknown }
	>();
	return {
		register(tool: { name: string; handler: Function }) {
			tools.set(tool.name, tool);
		},
		get(name: string) {
			return tools.get(name) as any;
		},
		list() {
			return [...tools.keys()];
		},
	};
}

function getTool(registry: WebMCPRegistry, name: string) {
	const tool = registry.get(name);
	if (!tool) throw new Error(`Tool "${name}" not registered`);
	return tool;
}

describe("registerGithubTools", () => {
	let registry: WebMCPRegistry;
	const API_BASE = "/api";

	beforeEach(() => {
		registry = createRegistry();
		mockFetch.mockReset();
	});

	it("should register all 3 tools", () => {
		registerGithubTools(registry, API_BASE);

		const names = registry.list();
		expect(names).toHaveLength(3);
		expect(names).toContain("getGithubStatus");
		expect(names).toContain("listWatchedRepos");
		expect(names).toContain("getRecentActivity");
	});

	it("should use default apiBase when not provided", () => {
		registerGithubTools(registry);

		expect(registry.list()).toHaveLength(3);
	});

	describe("getGithubStatus", () => {
		it("should GET /plugins/github/status", async () => {
			const status = {
				authenticated: true,
				username: "wopr-bot",
				orgs: ["wopr-network"],
				webhookUrl: "https://example.com/hooks/github",
				subscriptionCount: 3,
			};
			mockFetch.mockResolvedValue(mockJsonResponse(status));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getGithubStatus");
			const result = await tool.handler({}, {});

			expect(mockFetch).toHaveBeenCalledWith(
				"/api/plugins/github/status",
				expect.any(Object),
			);
			expect(result).toEqual(status);
		});

		it("should include bearer token when auth.token is present", async () => {
			mockFetch.mockResolvedValue(
				mockJsonResponse({ authenticated: true }),
			);
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getGithubStatus");
			const auth: AuthContext = { token: "my-token" };
			await tool.handler({}, auth);

			const headers = mockFetch.mock.calls[0][1].headers;
			expect(headers.Authorization).toBe("Bearer my-token");
		});

		it("should not include Authorization header when no token", async () => {
			mockFetch.mockResolvedValue(
				mockJsonResponse({ authenticated: false }),
			);
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getGithubStatus");
			await tool.handler({}, {});

			const headers = mockFetch.mock.calls[0][1].headers;
			expect(headers.Authorization).toBeUndefined();
		});
	});

	describe("listWatchedRepos", () => {
		it("should GET /plugins/github/repos", async () => {
			const repos = {
				repos: [
					{
						repo: "wopr-network/wopr",
						webhookId: 42,
						events: ["push"],
						session: null,
						createdAt: "2026-01-01T00:00:00Z",
					},
				],
			};
			mockFetch.mockResolvedValue(mockJsonResponse(repos));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "listWatchedRepos");
			const result = await tool.handler({}, {});

			expect(mockFetch).toHaveBeenCalledWith(
				"/api/plugins/github/repos",
				expect.any(Object),
			);
			expect(result).toEqual(repos);
		});

		it("should include bearer token in auth header", async () => {
			mockFetch.mockResolvedValue(mockJsonResponse({ repos: [] }));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "listWatchedRepos");
			await tool.handler({}, { token: "tok-repos" });

			const headers = mockFetch.mock.calls[0][1].headers;
			expect(headers.Authorization).toBe("Bearer tok-repos");
		});
	});

	describe("getRecentActivity", () => {
		it("should GET /plugins/github/activity without params", async () => {
			const activity = {
				items: [
					{
						type: "pr",
						repo: "owner/repo",
						number: 1,
						title: "Test",
						state: "OPEN",
						author: "dev",
						url: "https://github.com/owner/repo/pull/1",
						updatedAt: "2026-02-13T00:00:00Z",
					},
				],
			};
			mockFetch.mockResolvedValue(mockJsonResponse(activity));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getRecentActivity");
			const result = await tool.handler({}, {});

			expect(mockFetch).toHaveBeenCalledWith(
				"/api/plugins/github/activity",
				expect.any(Object),
			);
			expect(result).toEqual(activity);
		});

		it("should pass repo and limit as query params", async () => {
			mockFetch.mockResolvedValue(mockJsonResponse({ items: [] }));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getRecentActivity");
			await tool.handler({ repo: "owner/repo", limit: 5 }, {});

			const url = mockFetch.mock.calls[0][0];
			expect(url).toContain("/api/plugins/github/activity?");
			expect(url).toContain("repo=owner%2Frepo");
			expect(url).toContain("limit=5");
		});

		it("should pass only repo when limit is not provided", async () => {
			mockFetch.mockResolvedValue(mockJsonResponse({ items: [] }));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getRecentActivity");
			await tool.handler({ repo: "owner/repo" }, {});

			const url = mockFetch.mock.calls[0][0];
			expect(url).toContain("repo=owner%2Frepo");
			expect(url).not.toContain("limit=");
		});

		it("should include bearer token in auth header", async () => {
			mockFetch.mockResolvedValue(mockJsonResponse({ items: [] }));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getRecentActivity");
			await tool.handler({}, { token: "tok-activity" });

			const headers = mockFetch.mock.calls[0][1].headers;
			expect(headers.Authorization).toBe("Bearer tok-activity");
		});
	});

	describe("error handling", () => {
		it("should throw on non-ok response with error from body", async () => {
			mockFetch.mockResolvedValue(
				mockJsonResponse(
					{ error: "GitHub plugin not loaded" },
					false,
					404,
				),
			);
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getGithubStatus");

			await expect(tool.handler({}, {})).rejects.toThrow(
				"GitHub plugin not loaded",
			);
		});

		it("should throw with status code when body has no error field", async () => {
			mockFetch.mockResolvedValue(mockJsonResponse({}, false, 500));
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "listWatchedRepos");

			await expect(tool.handler({}, {})).rejects.toThrow(
				"Request failed (500)",
			);
		});

		it("should handle json parse failure on error response", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 502,
				json: vi
					.fn()
					.mockRejectedValue(new Error("invalid json")),
			});
			registerGithubTools(registry, API_BASE);

			const tool = getTool(registry, "getRecentActivity");

			await expect(tool.handler({}, {})).rejects.toThrow(
				"Request failed",
			);
		});
	});
});

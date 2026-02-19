import { describe, it, expect, vi, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	WOPRPluginContext,
	GitHubConfig,
	GitHubExtension,
} from "../src/types.js";

// Mock child_process before importing the plugin
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

// Path to the subscriptions file that the plugin persists
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_PATH = join(__dirname, "..", "data", "subscriptions.json");

// Dynamic import to ensure mocks are in place
const { default: plugin } = await import("../src/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecSync(returnValue: string) {
	mockSpawnSync(returnValue, 0);
}

function mockSpawnSync(stdout: string, status = 0) {
	vi.mocked(spawnSync).mockReturnValue({
		stdout,
		stderr: "",
		status,
		signal: null,
		pid: 1234,
		output: [null, stdout, ""],
		error: undefined,
	} as SpawnSyncReturns<string>);
}

function mockSpawnSyncError(stderr: string) {
	vi.mocked(spawnSync).mockReturnValue({
		stdout: "",
		stderr,
		status: 1,
		signal: null,
		pid: 1234,
		output: [null, "", stderr],
		error: undefined,
	} as SpawnSyncReturns<string>);
}

let configStore: GitHubConfig | undefined;
let extensions: Record<string, unknown> = {};

function makeCtx(config?: GitHubConfig): WOPRPluginContext {
	configStore = config;
	extensions = {};
	return {
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		getConfig<T>() {
			return configStore as T | undefined;
		},
		getMainConfig<T>() {
			return undefined as T | undefined;
		},
		registerExtension(name: string, ext: unknown) {
			extensions[name] = ext;
		},
		unregisterExtension(name: string) {
			delete extensions[name];
		},
		getExtension(name: string) {
			return extensions[name];
		},
	} as unknown as WOPRPluginContext;
}

function getGitHubExtension(): GitHubExtension {
	return extensions["github"] as GitHubExtension;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubExtension WebMCP methods", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		// Shutdown any previous plugin state to avoid subscription leaks
		await plugin.shutdown?.();
		// Remove persisted subscriptions file to avoid cross-test contamination
		try {
			rmSync(SUBSCRIPTIONS_PATH);
		} catch {
			// file may not exist
		}
		// Init with gh not authenticated by default
		mockExecSync("");
	});

	describe("getStatus", () => {
		it("should return unauthenticated status when gh CLI is not authenticated", async () => {
			const ctx = makeCtx({ orgs: ["wopr-network"] });
			mockSpawnSyncError("not authenticated");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			const status = await ext.getStatus();

			expect(status.authenticated).toBe(false);
			expect(status.username).toBe("unknown");
			expect(status.orgs).toEqual(["wopr-network"]);
			expect(status.webhookUrl).toBeNull();
			expect(status.subscriptionCount).toBe(0);
		});

		it("should return authenticated status with username", async () => {
			const ctx = makeCtx({ orgs: ["test-org", "other-org"] });
			mockExecSync("test-user\n");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			// Mock the gh auth status check and gh api user call
			// Both now go through spawnSync via execGh()
			vi.mocked(spawnSync).mockImplementation(
				(cmd: string, args?: readonly string[]) => {
					const argsArr = args as string[] | undefined;
					if (argsArr?.includes("auth")) {
						return {
							stdout: "Logged in",
							stderr: "",
							status: 0,
							signal: null,
							pid: 1234,
							output: [null, "Logged in", ""],
							error: undefined,
						} as SpawnSyncReturns<string>;
					}
					if (argsArr?.includes("api")) {
						return {
							stdout: "wopr-bot",
							stderr: "",
							status: 0,
							signal: null,
							pid: 1234,
							output: [null, "wopr-bot", ""],
							error: undefined,
						} as SpawnSyncReturns<string>;
					}
					return {
						stdout: "",
						stderr: "",
						status: 0,
						signal: null,
						pid: 1234,
						output: [null, "", ""],
						error: undefined,
					} as SpawnSyncReturns<string>;
				},
			);

			const status = await ext.getStatus();

			expect(status.authenticated).toBe(true);
			expect(status.username).toBe("wopr-bot");
			expect(status.orgs).toEqual(["test-org", "other-org"]);
		});

		it("should return zero subscriptionCount when no repos are watched", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			mockSpawnSyncError("not authenticated");

			const status = await ext.getStatus();
			expect(status.subscriptionCount).toBe(0);
		});

		it("should return empty orgs when none configured", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			mockSpawnSyncError("not authenticated");

			const status = await ext.getStatus();
			expect(status.orgs).toEqual([]);
		});
	});

	describe("listWatchedRepos", () => {
		it("should return empty array when no subscriptions exist", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			expect(ext.listWatchedRepos()).toEqual([]);
		});

		it("should return watched repo info from subscriptions", async () => {
			const ctx = makeCtx({
				subscriptions: {
					"owner/repo1": {
						repo: "owner/repo1",
						webhookId: 42,
						events: ["push", "pull_request"],
						session: "code-review",
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				},
			});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			const repos = ext.listWatchedRepos();

			expect(repos).toHaveLength(1);
			expect(repos[0]).toEqual({
				repo: "owner/repo1",
				webhookId: 42,
				events: ["push", "pull_request"],
				session: "code-review",
				createdAt: "2026-01-01T00:00:00.000Z",
			});
		});

		it("should map session to null when not set on subscription", async () => {
			const ctx = makeCtx({
				subscriptions: {
					"owner/repo2": {
						repo: "owner/repo2",
						webhookId: 99,
						events: ["issues"],
						createdAt: "2026-02-01T00:00:00.000Z",
					},
				},
			});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			const repos = ext.listWatchedRepos();

			expect(repos[0].session).toBeNull();
		});
	});

	describe("getRecentActivity", () => {
		it("should return empty array when no repos watched and no repo specified", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			expect(ext.getRecentActivity()).toEqual([]);
		});

		it("should fetch PRs and issues for a specific repo", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			const prData = [
				{
					number: 1,
					title: "Test PR",
					state: "OPEN",
					author: { login: "dev1" },
					url: "https://github.com/owner/repo/pull/1",
					updatedAt: "2026-02-13T10:00:00Z",
				},
			];
			const issueData = [
				{
					number: 5,
					title: "Bug report",
					state: "OPEN",
					author: { login: "user2" },
					url: "https://github.com/owner/repo/issues/5",
					updatedAt: "2026-02-13T09:00:00Z",
				},
			];

			vi.mocked(spawnSync).mockImplementation(
				(_cmd: string, args?: readonly string[]) => {
					const argsStr = args?.join(" ") ?? "";
					if (argsStr.includes("pr") && argsStr.includes("list")) {
						return {
							stdout: JSON.stringify(prData),
							stderr: "",
							status: 0,
							signal: null,
							pid: 1234,
							output: [null, JSON.stringify(prData), ""],
							error: undefined,
						} as SpawnSyncReturns<string>;
					}
					if (argsStr.includes("issue") && argsStr.includes("list")) {
						return {
							stdout: JSON.stringify(issueData),
							stderr: "",
							status: 0,
							signal: null,
							pid: 1234,
							output: [null, JSON.stringify(issueData), ""],
							error: undefined,
						} as SpawnSyncReturns<string>;
					}
					return {
						stdout: "",
						stderr: "",
						status: 0,
						signal: null,
						pid: 1234,
						output: [null, "", ""],
						error: undefined,
					} as SpawnSyncReturns<string>;
				},
			);

			const items = ext.getRecentActivity("owner/repo", 10);

			expect(items).toHaveLength(2);
			// Sorted by updatedAt descending
			expect(items[0].type).toBe("pr");
			expect(items[0].number).toBe(1);
			expect(items[0].author).toBe("dev1");
			expect(items[1].type).toBe("issue");
			expect(items[1].number).toBe(5);
		});

		it("should respect limit parameter", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			const manyPRs = Array.from({ length: 10 }, (_, i) => ({
				number: i + 1,
				title: `PR ${i + 1}`,
				state: "OPEN",
				author: { login: "dev" },
				url: `https://github.com/owner/repo/pull/${i + 1}`,
				updatedAt: `2026-02-${String(13 - i).padStart(2, "0")}T00:00:00Z`,
			}));

			vi.mocked(spawnSync).mockImplementation(
				(_cmd: string, args?: readonly string[]) => {
					const argsStr = args?.join(" ") ?? "";
					if (argsStr.includes("pr") && argsStr.includes("list")) {
						return {
							stdout: JSON.stringify(manyPRs),
							stderr: "",
							status: 0,
							signal: null,
							pid: 1234,
							output: [null, JSON.stringify(manyPRs), ""],
							error: undefined,
						} as SpawnSyncReturns<string>;
					}
					return {
						stdout: "[]",
						stderr: "",
						status: 0,
						signal: null,
						pid: 1234,
						output: [null, "[]", ""],
						error: undefined,
					} as SpawnSyncReturns<string>;
				},
			);

			const items = ext.getRecentActivity("owner/repo", 3);
			expect(items).toHaveLength(3);
		});

		it("should handle gh CLI errors gracefully", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();
			mockSpawnSyncError("API rate limit exceeded");

			const items = ext.getRecentActivity("owner/repo", 5);
			expect(items).toEqual([]);
		});

		it("should reject invalid repo format", async () => {
			const ctx = makeCtx({});
			mockExecSync("");
			await plugin.init!(ctx);

			const ext = getGitHubExtension();

			const items = ext.getRecentActivity("../traversal", 5);
			expect(items).toEqual([]);
		});
	});
});

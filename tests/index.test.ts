import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  WOPRPluginContext,
  GitHubConfig,
  GitHubExtension,
  WebhookEvent,
} from "../src/types.js";
import type { PluginStorageAPI } from "../src/storage.js";

// Mock child_process before importing the plugin
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

// Mock node:fs so subscriptions.json file operations are controlled in tests
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";

// Dynamic import to ensure mocks are in place
const { default: plugin } = await import("../src/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Legacy helper — sets spawnSync to return success with given stdout.
 * Previously this mocked execSync; now all code paths use spawnSync.
 */
function mockExecSync(returnValue: string) {
  mockSpawnSync(returnValue, 0);
}

function mockExecSyncError(message: string) {
  mockSpawnSyncError(message);
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

/**
 * Create an in-memory storage mock that implements PluginStorageAPI.
 * Used to test SQL-backed storage behavior without a real DB.
 */
function makeStorageMock(): PluginStorageAPI & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    _store: store,
    register: vi.fn(),
    async get(table: string, key: string) {
      return store.get(`${table}:${key}`) ?? null;
    },
    async put(table: string, key: string, value: unknown) {
      store.set(`${table}:${key}`, value);
    },
    async list(table: string) {
      const prefix = `${table}:`;
      const results: unknown[] = [];
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) results.push(v);
      }
      return results;
    },
    async delete(table: string, key: string) {
      store.delete(`${table}:${key}`);
    },
  };
}

function makeCtx(config?: GitHubConfig, storage?: PluginStorageAPI): WOPRPluginContext {
  configStore = config;
  extensions = {};
  const ctx: any = {
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
  };
  if (storage) {
    ctx.storage = storage;
  }
  return ctx as WOPRPluginContext;
}

function getGitHubExtension(): GitHubExtension {
  return extensions["github"] as GitHubExtension;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wopr-plugin-github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up module state after each test
    await plugin.shutdown?.();
  });

  // ========================================================================
  // Plugin metadata
  // ========================================================================

  describe("plugin metadata", () => {
    it("has correct name and version", () => {
      expect(plugin.name).toBe("wopr-plugin-github");
      expect(plugin.version).toBe("1.0.0");
    });

    it("has a description", () => {
      expect(plugin.description).toBeDefined();
      expect(typeof plugin.description).toBe("string");
    });

    it("has a configSchema with fields", () => {
      expect(plugin.configSchema).toBeDefined();
      expect(plugin.configSchema!.fields.length).toBeGreaterThan(0);
    });

    it("defines the github command", () => {
      expect(plugin.commands).toBeDefined();
      expect(plugin.commands!.length).toBe(1);
      expect(plugin.commands![0].name).toBe("github");
    });
  });

  // ========================================================================
  // Plugin init / shutdown lifecycle
  // ========================================================================

  describe("init and shutdown", () => {
    it("registers the github extension on init", async () => {
      // gh is available and authenticated
      mockExecSync("gh available");

      const ctx = makeCtx({ orgs: ["test-org"] });
      await plugin.init!(ctx);

      expect(extensions["github"]).toBeDefined();
      expect(ctx.log.info).toHaveBeenCalledWith("GitHub CLI authenticated");
      expect(ctx.log.info).toHaveBeenCalledWith(
        "GitHub plugin initialized for orgs: test-org"
      );
    });

    it("warns when gh CLI is not found", async () => {
      mockExecSyncError("not found");

      const ctx = makeCtx();
      await plugin.init!(ctx);

      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("GitHub CLI (gh) not found")
      );
    });

    it("warns when gh CLI is not authenticated", async () => {
      // "which gh" succeeds, then "gh auth status" fails
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "/usr/bin/gh",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1234,
          output: [null, "/usr/bin/gh", ""],
          error: undefined,
        } as SpawnSyncReturns<string>) // which gh
        .mockReturnValueOnce({
          stdout: "",
          stderr: "not logged in",
          status: 1,
          signal: null,
          pid: 1234,
          output: [null, "", "not logged in"],
          error: undefined,
        } as SpawnSyncReturns<string>); // gh auth status

      const ctx = makeCtx();
      await plugin.init!(ctx);

      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("not authenticated")
      );
    });

    it("logs when no orgs are configured", async () => {
      mockExecSync("ok");

      const ctx = makeCtx();
      await plugin.init!(ctx);

      expect(ctx.log.info).toHaveBeenCalledWith(
        "GitHub plugin initialized (no orgs configured)"
      );
    });

    it("unregisters extension on shutdown", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);
      expect(extensions["github"]).toBeDefined();

      await plugin.shutdown!();
      expect(extensions["github"]).toBeUndefined();
    });
  });

  // ========================================================================
  // Event routing — resolveSession / handleWebhook
  // ========================================================================

  describe("event routing", () => {
    async function initWith(config: GitHubConfig) {
      mockExecSync("ok");
      const ctx = makeCtx(config);
      await plugin.init!(ctx);
      return getGitHubExtension();
    }

    it("routes via exact match in routing table", async () => {
      const ext = await initWith({
        routing: { pull_request: "code-review", issues: "triage" },
      });

      expect(ext.resolveSession("pull_request")).toBe("code-review");
      expect(ext.resolveSession("issues")).toBe("triage");
    });

    it("falls back to wildcard when no exact match", async () => {
      const ext = await initWith({
        routing: { pull_request: "code-review", "*": "catch-all" },
      });

      expect(ext.resolveSession("push")).toBe("catch-all");
      expect(ext.resolveSession("release")).toBe("catch-all");
    });

    it("prefers exact match over wildcard", async () => {
      const ext = await initWith({
        routing: { pull_request: "code-review", "*": "catch-all" },
      });

      expect(ext.resolveSession("pull_request")).toBe("code-review");
    });

    it("falls back to legacy prReviewSession for PR events", async () => {
      const ext = await initWith({
        prReviewSession: "legacy-pr-session",
      });

      expect(ext.resolveSession("pull_request")).toBe("legacy-pr-session");
      expect(ext.resolveSession("pull_request_review")).toBe(
        "legacy-pr-session"
      );
    });

    it("falls back to legacy releaseSession for push/release events", async () => {
      const ext = await initWith({
        releaseSession: "legacy-release-session",
      });

      expect(ext.resolveSession("release")).toBe("legacy-release-session");
      expect(ext.resolveSession("push")).toBe("legacy-release-session");
    });

    it("returns null when no route matches", async () => {
      const ext = await initWith({});

      expect(ext.resolveSession("pull_request")).toBeNull();
      expect(ext.resolveSession("push")).toBeNull();
      expect(ext.resolveSession("issues")).toBeNull();
    });

    it("ignores empty string routes in routing table", async () => {
      const ext = await initWith({
        routing: { pull_request: "", "*": "  " },
      });

      expect(ext.resolveSession("pull_request")).toBeNull();
    });

    it("routing table takes priority over legacy fields", async () => {
      const ext = await initWith({
        routing: { pull_request: "new-route" },
        prReviewSession: "legacy-route",
      });

      expect(ext.resolveSession("pull_request")).toBe("new-route");
    });
  });

  describe("handleWebhook", () => {
    async function initWith(config: GitHubConfig) {
      mockExecSync("ok");
      const ctx = makeCtx(config);
      await plugin.init!(ctx);
      return getGitHubExtension();
    }

    it("routes a known event type to the configured session", async () => {
      const ext = await initWith({
        routing: { pull_request: "code-review" },
      });

      const result = ext.handleWebhook({
        eventType: "pull_request",
        payload: { action: "opened" },
        deliveryId: "abc-123",
      });

      expect(result).toEqual({ routed: true, session: "code-review" });
    });

    it("returns routed:false for missing eventType", async () => {
      const ext = await initWith({
        routing: { pull_request: "code-review" },
      });

      const result = ext.handleWebhook({
        payload: { action: "opened" },
      } as WebhookEvent);

      expect(result.routed).toBe(false);
      expect(result.reason).toBe("Missing event type");
    });

    it("returns routed:false for undefined eventType", async () => {
      const ext = await initWith({
        routing: { pull_request: "code-review" },
      });

      const result = ext.handleWebhook({
        eventType: undefined,
        payload: {},
      });

      expect(result.routed).toBe(false);
    });

    it("returns routed:false when no session configured for event", async () => {
      const ext = await initWith({});

      const result = ext.handleWebhook({
        eventType: "deployment",
        payload: {},
        deliveryId: "xyz-789",
      });

      expect(result.routed).toBe(false);
      expect(result.reason).toContain("deployment");
    });

    it("handles empty string eventType as falsy", async () => {
      const ext = await initWith({
        routing: { "": "should-not-match" },
      });

      const result = ext.handleWebhook({
        eventType: "",
        payload: {},
      });

      expect(result.routed).toBe(false);
      expect(result.reason).toBe("Missing event type");
    });
  });

  // ========================================================================
  // viewPr / viewIssue — with mocked gh CLI
  // ========================================================================

  describe("viewPr", () => {
    async function initExt() {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);
      return getGitHubExtension();
    }

    it("parses a successful PR response", async () => {
      const ext = await initExt();

      const prData = {
        number: 42,
        title: "Add new feature",
        state: "OPEN",
        author: { login: "octocat" },
        labels: [{ name: "enhancement" }],
        body: "This PR adds a new feature",
        url: "https://github.com/owner/repo/pull/42",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        additions: 100,
        deletions: 20,
        headRefName: "feature-branch",
        baseRefName: "main",
      };

      mockSpawnSync(JSON.stringify(prData));

      const result = ext.viewPr("owner/repo", 42);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("pr");
      expect(result!.number).toBe(42);
      expect(result!.title).toBe("Add new feature");
      expect(result!.state).toBe("OPEN");
      expect(result!.author).toBe("octocat");
      expect(result!.labels).toEqual(["enhancement"]);
      expect(result!.additions).toBe(100);
      expect(result!.deletions).toBe(20);
      expect(result!.headRef).toBe("feature-branch");
      expect(result!.baseRef).toBe("main");
      expect(result!.mergeable).toBe("MERGEABLE");
      expect(result!.reviewDecision).toBe("APPROVED");
    });

    it("returns null when gh CLI fails", async () => {
      const ext = await initExt();
      mockSpawnSyncError("not found");

      const result = ext.viewPr("owner/repo", 999);
      expect(result).toBeNull();
    });

    it("returns null when response is not valid JSON", async () => {
      const ext = await initExt();
      mockSpawnSync("not json at all");

      const result = ext.viewPr("owner/repo", 42);
      expect(result).toBeNull();
    });

    it("handles missing author gracefully", async () => {
      const ext = await initExt();

      mockSpawnSync(
        JSON.stringify({
          number: 1,
          title: "Test",
          state: "OPEN",
          author: null,
          labels: [],
          body: "",
          url: "https://github.com/o/r/pull/1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = ext.viewPr("o/r", 1);
      expect(result).not.toBeNull();
      expect(result!.author).toBe("unknown");
    });

    it("truncates long body text", async () => {
      const ext = await initExt();
      const longBody = "A".repeat(300);

      mockSpawnSync(
        JSON.stringify({
          number: 1,
          title: "Test",
          state: "OPEN",
          author: { login: "user" },
          labels: [],
          body: longBody,
          url: "https://github.com/o/r/pull/1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = ext.viewPr("o/r", 1);
      expect(result!.bodyPreview.length).toBeLessThanOrEqual(200);
      expect(result!.bodyPreview).toMatch(/\.\.\.$/);
    });

    it("calls gh with correct arguments", async () => {
      const ext = await initExt();
      mockSpawnSyncError("fail");

      ext.viewPr("owner/repo", 42);

      expect(spawnSync).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["pr", "view", "42", "--repo", "owner/repo"]),
        expect.any(Object)
      );
    });
  });

  describe("viewIssue", () => {
    async function initExt() {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);
      return getGitHubExtension();
    }

    it("parses a successful issue response", async () => {
      const ext = await initExt();

      const issueData = {
        number: 10,
        title: "Bug report",
        state: "OPEN",
        author: { login: "reporter" },
        labels: [{ name: "bug" }, { name: "urgent" }],
        body: "Something is broken",
        url: "https://github.com/owner/repo/issues/10",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      };

      mockSpawnSync(JSON.stringify(issueData));

      const result = ext.viewIssue("owner/repo", 10);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("issue");
      expect(result!.number).toBe(10);
      expect(result!.title).toBe("Bug report");
      expect(result!.author).toBe("reporter");
      expect(result!.labels).toEqual(["bug", "urgent"]);
    });

    it("returns null when gh CLI fails", async () => {
      const ext = await initExt();
      mockSpawnSyncError("not found");

      const result = ext.viewIssue("owner/repo", 999);
      expect(result).toBeNull();
    });

    it("returns null for malformed JSON", async () => {
      const ext = await initExt();
      mockSpawnSync("{broken json");

      const result = ext.viewIssue("owner/repo", 1);
      expect(result).toBeNull();
    });
  });

  // ========================================================================
  // Webhook URL construction
  // ========================================================================

  describe("getWebhookUrl", () => {
    it("returns null when funnel extension is missing", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      const url = await ext.getWebhookUrl();
      expect(url).toBeNull();
    });

    it("returns null when webhooks extension is missing", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      // Register funnel but not webhooks
      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();
      const url = await ext.getWebhookUrl();
      expect(url).toBeNull();
    });

    it("builds correct URL when both extensions are available", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      // Pre-register extensions that getWebhookUrl depends on
      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();
      const url = await ext.getWebhookUrl();

      expect(url).toBe("https://my-host.ts.net/hooks/github");
    });

    it("returns null when funnel has no hostname", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => null,
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();
      const url = await ext.getWebhookUrl();
      expect(url).toBeNull();
    });

    it("returns null when webhooks config is null", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => null,
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();
      const url = await ext.getWebhookUrl();
      expect(url).toBeNull();
    });
  });

  // ========================================================================
  // isAuthenticated
  // ========================================================================

  describe("isAuthenticated", () => {
    it("returns true when gh auth status succeeds", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      mockExecSync("Logged in to github.com");
      const result = await ext.isAuthenticated();
      expect(result).toBe(true);
    });

    it("returns false when gh auth status fails", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      mockExecSyncError("not logged in");
      const result = await ext.isAuthenticated();
      expect(result).toBe(false);
    });
  });

  // ========================================================================
  // setupWebhook
  // ========================================================================

  describe("setupWebhook", () => {
    it("returns error when gh is not authenticated", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();

      // Now make auth check fail
      mockExecSyncError("not logged in");

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not authenticated");
    });

    it("returns error when no webhook URL available", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      // No funnel/webhooks extensions => no URL
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      mockExecSync("ok"); // auth succeeds

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No webhook URL available");
    });

    it("returns error when no webhook token configured", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();
      mockExecSync("ok"); // auth

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No webhook token configured");
    });

    it("detects existing webhook and returns its ID", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();

      // auth check succeeds
      mockExecSync("ok");
      // findOrgWebhookByUrl — exact match (alternating id/url lines)
      mockSpawnSync("12345\nhttps://my-host.ts.net/hooks/github");

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(true);
      expect(result.webhookId).toBe(12345);
    });

    it("creates a new webhook when none exists", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();

      // spawnSync call 1: checkGhAuth (auth check succeeds)
      // spawnSync call 2: findOrgWebhookByUrl — no exact match
      // spawnSync call 3: findAnyOrgWebhook — no stale webhook
      // spawnSync call 4: create hook returns new ID
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "67890",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "67890", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(true);
      expect(result.webhookId).toBe(67890);
      expect(result.webhookUrl).toBe("https://my-host.ts.net/hooks/github");
    });

    it("returns error when webhook creation fails", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);
      const ext = getGitHubExtension();

      // spawnSync call 1: checkGhAuth (auth succeeds)
      // spawnSync call 2: findOrgWebhookByUrl — no exact match
      // spawnSync call 3: findAnyOrgWebhook — no stale webhook
      // spawnSync call 4: create — fails
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "403 Forbidden",
          status: 1,
          signal: null,
          pid: 1,
          output: [null, "", "403 Forbidden"],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create webhook");
    });
  });

  // ========================================================================
  // Org parameter validation (WOP-236)
  // ========================================================================

  describe("org parameter validation", () => {
    async function initWithExtensions() {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["test-org"] });
      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };
      await plugin.init!(ctx);
      return getGitHubExtension();
    }

    it("rejects org with path traversal characters", async () => {
      const ext = await initWithExtensions();
      const result = await ext.setupWebhook("../repos/target");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid org name");
    });

    it("rejects org with slashes", async () => {
      const ext = await initWithExtensions();
      const result = await ext.setupWebhook("org/subpath");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid org name");
    });

    it("accepts org with dots", async () => {
      const ext = await initWithExtensions();
      // Dots are valid in GitHub org/user names
      // setupWebhook will proceed past validation (may fail for other reasons in test)
      const result = await ext.setupWebhook("org.name");
      // Should NOT fail with "Invalid org name"
      if (!result.success) {
        expect(result.error).not.toContain("Invalid org name");
      }
    });

    it("rejects org with spaces", async () => {
      const ext = await initWithExtensions();
      const result = await ext.setupWebhook("org name");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid org name");
    });

    it("rejects empty org", async () => {
      const ext = await initWithExtensions();
      const result = await ext.setupWebhook("");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid org name");
    });

    it("accepts valid org with alphanumeric and hyphens", async () => {
      const ext = await initWithExtensions();
      // Auth will fail, but we get past the validation
      mockExecSyncError("not logged in");
      const result = await ext.setupWebhook("my-valid-org-123");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not authenticated");
    });

    it("rejects invalid org in updateWebhook", async () => {
      const ext = await initWithExtensions();
      mockExecSync("ok"); // auth
      const result = await ext.updateWebhook(
        "../evil",
        "old-host.ts.net",
        "new-host.ts.net",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid org name");
    });

    it("rejects invalid org in command handler setup", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({});
      await plugin.init!(ctx);

      const handler = plugin.commands![0].handler;
      await handler(ctx, ["setup", "../evil-org"]);

      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid org name"),
      );
    });
  });

  // ========================================================================
  // Command handler
  // ========================================================================

  describe("command handler", () => {
    const handler = plugin.commands![0].handler;

    async function initAndGetCtx(config?: GitHubConfig) {
      mockExecSync("ok");
      const ctx = makeCtx(config);
      await plugin.init!(ctx);
      return ctx;
    }

    it("shows usage when no subcommand given", async () => {
      const ctx = await initAndGetCtx();
      await handler(ctx, []);

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("Usage:")
      );
    });

    describe("status subcommand", () => {
      it("shows authentication and webhook status", async () => {
        const ctx = await initAndGetCtx({ orgs: ["my-org"] });

        // auth check
        mockExecSync("ok");

        await handler(ctx, ["status"]);

        expect(ctx.log.info).toHaveBeenCalledWith(
          expect.stringContaining("authenticated")
        );
      });

      it("shows configured orgs", async () => {
        const ctx = await initAndGetCtx({ orgs: ["org1", "org2"] });
        mockExecSync("ok");

        await handler(ctx, ["status"]);

        expect(ctx.log.info).toHaveBeenCalledWith(
          expect.stringContaining("org1, org2")
        );
      });
    });

    describe("pr subcommand", () => {
      it("errors when no argument given", async () => {
        const ctx = await initAndGetCtx();
        await handler(ctx, ["pr"]);

        expect(ctx.log.error).toHaveBeenCalledWith(
          expect.stringContaining("Usage:")
        );
      });

      it("errors on invalid ref format", async () => {
        const ctx = await initAndGetCtx();
        await handler(ctx, ["pr", "invalid-format"]);

        expect(ctx.log.error).toHaveBeenCalledWith(
          expect.stringContaining("Invalid format")
        );
      });

      it("fetches and displays PR details", async () => {
        const ctx = await initAndGetCtx();

        mockSpawnSync(
          JSON.stringify({
            number: 42,
            title: "My PR",
            state: "OPEN",
            author: { login: "dev" },
            labels: [],
            body: "Description",
            url: "https://github.com/owner/repo/pull/42",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            headRefName: "feature",
            baseRefName: "main",
            additions: 10,
            deletions: 5,
          })
        );

        await handler(ctx, ["pr", "owner/repo#42"]);

        // Should have logged formatted summary (called after init, so
        // look at the last info call)
        const infoCalls = vi.mocked(ctx.log.info).mock.calls;
        const lastInfoCall = infoCalls[infoCalls.length - 1][0];
        expect(lastInfoCall).toContain("PR #42");
        expect(lastInfoCall).toContain("My PR");
      });

      it("shows error when PR not found", async () => {
        const ctx = await initAndGetCtx();

        // viewPr fails, then the fallback gh call also fails
        mockSpawnSyncError("Could not resolve");

        await handler(ctx, ["pr", "owner/repo#999"]);

        // First spawnSync fails for viewPr, second for the detail check
        const errorCalls = vi.mocked(ctx.log.error).mock.calls;
        expect(errorCalls.length).toBeGreaterThan(0);
        expect(errorCalls[errorCalls.length - 1][0]).toContain(
          "Could not fetch PR"
        );
      });
    });

    describe("issue subcommand", () => {
      it("errors when no argument given", async () => {
        const ctx = await initAndGetCtx();
        await handler(ctx, ["issue"]);

        expect(ctx.log.error).toHaveBeenCalledWith(
          expect.stringContaining("Usage:")
        );
      });

      it("errors on invalid ref format", async () => {
        const ctx = await initAndGetCtx();
        await handler(ctx, ["issue", "bad"]);

        expect(ctx.log.error).toHaveBeenCalledWith(
          expect.stringContaining("Invalid format")
        );
      });

      it("fetches and displays issue details", async () => {
        const ctx = await initAndGetCtx();

        mockSpawnSync(
          JSON.stringify({
            number: 10,
            title: "Bug",
            state: "OPEN",
            author: { login: "reporter" },
            labels: [{ name: "bug" }],
            body: "It is broken",
            url: "https://github.com/owner/repo/issues/10",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          })
        );

        await handler(ctx, ["issue", "owner/repo#10"]);

        const infoCalls = vi.mocked(ctx.log.info).mock.calls;
        const lastInfoCall = infoCalls[infoCalls.length - 1][0];
        expect(lastInfoCall).toContain("Issue #10");
        expect(lastInfoCall).toContain("Bug");
      });
    });

    describe("setup subcommand", () => {
      it("errors when no org specified and none configured", async () => {
        const ctx = await initAndGetCtx({});
        await handler(ctx, ["setup"]);

        expect(ctx.log.error).toHaveBeenCalledWith(
          expect.stringContaining("No org specified")
        );
      });

      it("uses configured orgs when no arg given", async () => {
        const ctx = await initAndGetCtx({ orgs: ["my-org"] });

        // Auth fails so we get a clean error
        mockExecSyncError("not logged in");

        await handler(ctx, ["setup"]);

        expect(ctx.log.info).toHaveBeenCalledWith(
          expect.stringContaining("Setting up webhook for my-org")
        );
      });

      it("uses the org argument when provided", async () => {
        const ctx = await initAndGetCtx({});

        mockExecSyncError("not logged in");

        await handler(ctx, ["setup", "explicit-org"]);

        expect(ctx.log.info).toHaveBeenCalledWith(
          expect.stringContaining("Setting up webhook for explicit-org")
        );
      });
    });

    describe("url subcommand", () => {
      it("shows webhook URL when available", async () => {
        const ctx = await initAndGetCtx();

        extensions["funnel"] = {
          getHostname: async () => "my-host.ts.net",
        };
        extensions["webhooks"] = {
          getConfig: () => ({ basePath: "/hooks", token: "s" }),
        };

        await handler(ctx, ["url"]);

        const infoCalls = vi.mocked(ctx.log.info).mock.calls;
        const lastInfoCall = infoCalls[infoCalls.length - 1][0];
        expect(lastInfoCall).toContain("https://my-host.ts.net/hooks/github");
      });

      it("shows error when URL not available", async () => {
        const ctx = await initAndGetCtx();
        await handler(ctx, ["url"]);

        expect(ctx.log.error).toHaveBeenCalledWith(
          expect.stringContaining("not available")
        );
      });
    });

    describe("webhook subcommand (alias for setup)", () => {
      it("behaves the same as setup", async () => {
        const ctx = await initAndGetCtx({ orgs: ["test-org"] });
        mockExecSyncError("not logged in");

        await handler(ctx, ["webhook"]);

        expect(ctx.log.info).toHaveBeenCalledWith(
          expect.stringContaining("Setting up webhook for test-org")
        );
      });
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe("edge cases", () => {
    it("handles spawnSync throwing an exception", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();

      vi.mocked(spawnSync).mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const result = ext.viewPr("owner/repo", 1);
      expect(result).toBeNull();
    });

    it("handles body with newlines in truncation", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();

      mockSpawnSync(
        JSON.stringify({
          number: 1,
          title: "Test",
          state: "OPEN",
          author: { login: "user" },
          labels: [],
          body: "Line 1\nLine 2\nLine 3",
          url: "https://github.com/o/r/pull/1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = ext.viewPr("o/r", 1);
      expect(result!.bodyPreview).not.toContain("\n");
      expect(result!.bodyPreview).toBe("Line 1 Line 2 Line 3");
    });

    it("handles empty labels array", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      mockSpawnSync(
        JSON.stringify({
          number: 1,
          title: "Test",
          state: "OPEN",
          author: { login: "user" },
          labels: [],
          body: "",
          url: "https://github.com/o/r/pull/1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = ext.viewPr("o/r", 1);
      expect(result!.labels).toEqual([]);
    });

    it("handles null body", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      mockSpawnSync(
        JSON.stringify({
          number: 1,
          title: "Test",
          state: "OPEN",
          author: { login: "user" },
          labels: [],
          body: null,
          url: "https://github.com/o/r/pull/1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        })
      );

      const result = ext.viewPr("o/r", 1);
      expect(result!.bodyPreview).toBe("");
    });

    it("parseRef rejects URLs and plain numbers", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      // Test via command handler — invalid formats should be rejected
      const handler = plugin.commands![0].handler;

      await handler(ctx, ["pr", "42"]);
      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid format")
      );

      vi.mocked(ctx.log.error).mockClear();
      await handler(ctx, ["pr", "https://github.com/o/r/pull/42"]);
      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid format")
      );
    });

    it("parseRef accepts owner/repo#number format", async () => {
      mockExecSync("ok");
      const ctx = makeCtx();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();

      // If parseRef works, viewPr will be called with correct args
      mockSpawnSyncError("not found");
      ext.viewPr("owner/repo", 42);

      expect(spawnSync).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["pr", "view", "42", "--repo", "owner/repo"]),
        expect.any(Object)
      );
    });
  });

  // ========================================================================
  // updateWebhook
  // ========================================================================

  describe("updateWebhook", () => {
    async function initWithExtensions() {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["test-org"] });
      extensions["funnel"] = {
        getHostname: async () => "new-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };
      await plugin.init!(ctx);
      return getGitHubExtension();
    }

    it("finds and patches an existing webhook by old URL", async () => {
      const ext = await initWithExtensions();

      // spawnSync call 1: checkGhAuth (auth check succeeds)
      // spawnSync call 2: findOrgWebhookByUrl(newUrl) — no match (not already updated)
      // spawnSync call 3: findOrgWebhookByUrl(oldUrl) — finds hook 999
      // spawnSync call 4: PATCH — returns 999
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "999\nhttps://old-host.ts.net/hooks/github",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "999\nhttps://old-host.ts.net/hooks/github", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "999",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "999", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const result = await ext.updateWebhook(
        "test-org",
        "old-host.ts.net",
        "new-host.ts.net",
      );
      expect(result.success).toBe(true);
      expect(result.webhookId).toBe(999);
      expect(result.webhookUrl).toBe(
        "https://new-host.ts.net/hooks/github",
      );
    });

    it("returns error when no existing webhook found", async () => {
      const ext = await initWithExtensions();

      // spawnSync call 1: checkGhAuth (auth succeeds)
      // spawnSync call 2: findOrgWebhookByUrl(newUrl) — no match
      // spawnSync call 3: findOrgWebhookByUrl(oldUrl) — no match
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const result = await ext.updateWebhook(
        "test-org",
        "old-host.ts.net",
        "new-host.ts.net",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("No existing webhook found");
    });

    it("returns error when PATCH fails", async () => {
      const ext = await initWithExtensions();

      // spawnSync call 1: checkGhAuth (auth succeeds)
      // spawnSync call 2: findOrgWebhookByUrl(newUrl) — no match
      // spawnSync call 3: findOrgWebhookByUrl(oldUrl) — finds hook 999
      // spawnSync call 4: PATCH — fails
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "999\nhttps://old-host.ts.net/hooks/github",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "999\nhttps://old-host.ts.net/hooks/github", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "403 Forbidden",
          status: 1,
          signal: null,
          pid: 1,
          output: [null, "", "403 Forbidden"],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const result = await ext.updateWebhook(
        "test-org",
        "old-host.ts.net",
        "new-host.ts.net",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to update webhook");
    });

    it("returns error when webhooks extension not configured", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["test-org"] });
      // No webhooks extension
      await plugin.init!(ctx);
      const ext = getGitHubExtension();

      // auth check succeeds
      mockExecSync("ok");

      const result = await ext.updateWebhook(
        "test-org",
        "old-host.ts.net",
        "new-host.ts.net",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });
  });

  // ========================================================================
  // Idempotent setup — stale webhook update
  // ========================================================================

  describe("idempotent setup (stale webhook)", () => {
    it("updates stale webhook instead of creating duplicate", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["test-org"] });
      extensions["funnel"] = {
        getHostname: async () => "new-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };
      await plugin.init!(ctx);
      const ext = getGitHubExtension();

      // spawnSync call 1: checkGhAuth (auth succeeds)
      // spawnSync call 2: findOrgWebhookByUrl — no exact match
      // spawnSync call 3: findAnyOrgWebhook — finds stale hook 555 (alternating id/url lines)
      // spawnSync call 4: PATCH — returns 555
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "555\nhttps://old-host.ts.net/hooks/github",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [
            null,
            "555\nhttps://old-host.ts.net/hooks/github",
            "",
          ],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "555",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "555", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const result = await ext.setupWebhook("test-org");
      expect(result.success).toBe(true);
      expect(result.webhookId).toBe(555);
      expect(result.webhookUrl).toBe(
        "https://new-host.ts.net/hooks/github",
      );
    });
  });

  // ========================================================================
  // Event subscriptions — webhooks:ready and funnel:hostname-changed
  // ========================================================================

  describe("event subscriptions", () => {
    it("auto-sets up org webhooks on webhooks:ready event", async () => {
      mockExecSync("ok");

      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const ctx = makeCtx({ orgs: ["auto-org"] });
      (ctx as any).events = {
        on(event: string, listener: (...args: any[]) => void) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(listener);
        },
        off() {},
      };

      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);

      // Verify webhooks:ready listener was registered
      expect(listeners["webhooks:ready"]).toBeDefined();
      expect(listeners["webhooks:ready"].length).toBe(1);

      // Simulate webhooks:ready event
      // setupOrgWebhook will call: auth (execSync), findOrgWebhookByUrl (spawnSync)
      mockExecSync("ok");
      // findOrgWebhookByUrl returns existing (alternating id/url lines)
      mockSpawnSync("12345\nhttps://my-host.ts.net/hooks/github");

      await listeners["webhooks:ready"][0]();

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("webhooks:ready received"),
      );
      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("Auto-setup webhook for auto-org"),
      );
    });

    it("updates webhooks on funnel:hostname-changed event", async () => {
      mockExecSync("ok");

      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const ctx = makeCtx({ orgs: ["change-org"] });
      (ctx as any).events = {
        on(event: string, listener: (...args: any[]) => void) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(listener);
        },
        off() {},
      };

      extensions["funnel"] = {
        getHostname: async () => "new-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);

      expect(listeners["funnel:hostname-changed"]).toBeDefined();

      // Simulate hostname change
      // updateOrgWebhook calls: checkGhAuth, findOrgWebhookByUrl(newUrl),
      //   findOrgWebhookByUrl(oldUrl), PATCH — all via spawnSync
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "777\nhttps://old-host.ts.net/hooks/github",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "777\nhttps://old-host.ts.net/hooks/github", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "777",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "777", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      await listeners["funnel:hostname-changed"][0]({
        oldHostname: "old-host.ts.net",
        newHostname: "new-host.ts.net",
      });

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("funnel:hostname-changed received"),
      );
      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("Updated org webhook for change-org"),
      );
    });

    it("does not subscribe to events when ctx.events is undefined", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["no-events-org"] });
      // ctx.events is undefined by default in makeCtx

      await plugin.init!(ctx);

      // Should init without error and not try to register listeners
      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("GitHub plugin initialized"),
      );
    });

    it("unsubscribes from events on shutdown", async () => {
      mockExecSync("ok");

      const offCalls: string[] = [];
      const ctx = makeCtx({ orgs: ["shutdown-org"] });
      (ctx as any).events = {
        on() {},
        off(event: string) {
          offCalls.push(event);
        },
      };

      await plugin.init!(ctx);
      await plugin.shutdown!();

      expect(offCalls).toContain("webhooks:ready");
      expect(offCalls).toContain("funnel:hostname-changed");
    });
  });

  // ========================================================================
  // Enhanced status command
  // ========================================================================

  describe("enhanced status command", () => {
    const handler = plugin.commands![0].handler;

    it("shows per-org webhook status with URL match", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["status-org"] });
      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);

      // auth check succeeds
      mockExecSync("ok");
      // findOrgWebhookByUrl finds exact match (alternating id/url lines)
      mockSpawnSync("12345\nhttps://my-host.ts.net/hooks/github");

      await handler(ctx, ["status"]);

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("status-org: webhook 12345 (URL matches)"),
      );
    });

    it("shows URL MISMATCH for stale webhook", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["stale-org"] });
      extensions["funnel"] = {
        getHostname: async () => "new-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);

      // spawnSync call 1: checkGhAuth (auth succeeds)
      // spawnSync call 2: findOrgWebhookByUrl — no exact match
      // spawnSync call 3: findAnyOrgWebhook — finds stale (alternating id/url format)
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "444\nhttps://old-host.ts.net/hooks/github",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [
            null,
            "444\nhttps://old-host.ts.net/hooks/github",
            "",
          ],
          error: undefined,
        } as SpawnSyncReturns<string>);

      await handler(ctx, ["status"]);

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("stale-org: webhook 444 (URL MISMATCH"),
      );
    });

    it("shows no webhook configured when none found", async () => {
      mockExecSync("ok");
      const ctx = makeCtx({ orgs: ["no-hook-org"] });
      extensions["funnel"] = {
        getHostname: async () => "my-host.ts.net",
      };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret123" }),
      };

      await plugin.init!(ctx);

      mockExecSync("ok"); // auth
      // findOrgWebhookByUrl — no exact match
      // findAnyOrgWebhook — no stale match
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      await handler(ctx, ["status"]);

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("no-hook-org: no webhook configured"),
      );
    });
  });

  // ========================================================================
  // Storage API — SQL-backed subscription persistence
  // ========================================================================

  describe("Storage API — subscription persistence", () => {
    beforeEach(() => {
      // Default: no subscriptions.json file present
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it("registers the subscriptions schema with storage on init", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();
      const ctx = makeCtx({}, storage);

      await plugin.init!(ctx);

      expect(storage.register).toHaveBeenCalledWith(
        expect.stringContaining("subscriptions"),
        expect.any(Object),
      );
    });

    it("persists a new subscription to storage when subscribing", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();
      const ctx = makeCtx({}, storage);

      extensions["funnel"] = { getHostname: async () => "host.ts.net" };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret" }),
      };

      await plugin.init!(ctx);

      // spawnSync call 1: checkGhAuth (auth succeeds)
      // spawnSync call 2: repo webhook check (no existing)
      // spawnSync call 3: create returns ID
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          stdout: "Logged in",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "Logged in", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "", ""],
          error: undefined,
        } as SpawnSyncReturns<string>)
        .mockReturnValueOnce({
          stdout: "42",
          stderr: "",
          status: 0,
          signal: null,
          pid: 1,
          output: [null, "42", ""],
          error: undefined,
        } as SpawnSyncReturns<string>);

      const ext = getGitHubExtension();
      const result = await ext.subscribe("owner/repo");

      expect(result.success).toBe(true);
      // Subscription should be in storage
      const stored = await storage.get("github_subscriptions", "owner/repo");
      expect(stored).not.toBeNull();
      expect((stored as any).repo).toBe("owner/repo");
      expect((stored as any).webhookId).toBe(42);
    });

    it("removes subscription from storage when unsubscribing", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();
      const ctx = makeCtx({}, storage);

      extensions["funnel"] = { getHostname: async () => "host.ts.net" };
      extensions["webhooks"] = {
        getConfig: () => ({ basePath: "/hooks", token: "secret" }),
      };

      await plugin.init!(ctx);

      // Pre-populate storage with a subscription
      await storage.put("github_subscriptions", "owner/repo", {
        repo: "owner/repo",
        webhookId: 99,
        events: ["push"],
        createdAt: new Date().toISOString(),
      });

      // Reload subscriptions from storage (simulating restart)
      // Re-init picks up the stored subscription
      await plugin.shutdown!();
      await plugin.init!(ctx);

      const ext = getGitHubExtension();

      // auth check succeeds, then DELETE succeeds
      mockExecSync("ok");
      vi.mocked(spawnSync).mockReturnValueOnce({
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
        pid: 1,
        output: [null, "", ""],
        error: undefined,
      } as SpawnSyncReturns<string>);

      const result = await ext.unsubscribe("owner/repo");
      expect(result.success).toBe(true);

      // Should be removed from storage
      const stored = await storage.get("github_subscriptions", "owner/repo");
      expect(stored).toBeNull();
    });

    it("loads subscriptions from storage on init", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();

      // Pre-populate storage
      await storage.put("github_subscriptions", "pre/loaded", {
        repo: "pre/loaded",
        webhookId: 77,
        events: ["push", "pull_request"],
        createdAt: "2024-01-01T00:00:00Z",
      });

      const ctx = makeCtx({}, storage);
      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      const subs = ext.listSubscriptions();

      expect(subs).toHaveLength(1);
      expect(subs[0].repo).toBe("pre/loaded");
      expect(subs[0].webhookId).toBe(77);
    });

    it("logs loaded subscription count from storage", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();

      await storage.put("github_subscriptions", "a/b", {
        repo: "a/b",
        webhookId: 1,
        events: ["push"],
        createdAt: "2024-01-01T00:00:00Z",
      });
      await storage.put("github_subscriptions", "c/d", {
        repo: "c/d",
        webhookId: 2,
        events: ["push"],
        createdAt: "2024-01-01T00:00:00Z",
      });

      const ctx = makeCtx({}, storage);
      await plugin.init!(ctx);

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("2 repo subscription(s)"),
      );
    });

    it("migrates subscriptions.json to storage on first run", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();

      // Simulate subscriptions.json file exists
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          "legacy/repo": {
            repo: "legacy/repo",
            webhookId: 55,
            events: ["push"],
            createdAt: "2024-01-01T00:00:00Z",
          },
        }),
      );

      const ctx = makeCtx({}, storage);
      await plugin.init!(ctx);

      // Legacy data migrated to storage
      const stored = await storage.get("github_subscriptions", "legacy/repo");
      expect(stored).not.toBeNull();
      expect((stored as any).webhookId).toBe(55);

      // The JSON file should be deleted after migration
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("falls back to config subscriptions when storage is empty and no file", async () => {
      mockExecSync("ok");
      const storage = makeStorageMock();

      // No file, empty storage — config has initial subscriptions
      const ctx = makeCtx(
        {
          subscriptions: {
            "config/repo": {
              repo: "config/repo",
              webhookId: 33,
              events: ["pull_request"],
              createdAt: "2024-01-01T00:00:00Z",
            },
          },
        },
        storage,
      );

      await plugin.init!(ctx);

      const ext = getGitHubExtension();
      const subs = ext.listSubscriptions();

      expect(subs).toHaveLength(1);
      expect(subs[0].repo).toBe("config/repo");
      // Config data should also be persisted to storage
      const stored = await storage.get("github_subscriptions", "config/repo");
      expect(stored).not.toBeNull();
    });

    it("works without storage (graceful degradation) — no crash", async () => {
      mockExecSync("ok");
      // No storage provided — context does not have storage API
      const ctx = makeCtx({});

      // Should init without errors
      await expect(plugin.init!(ctx)).resolves.not.toThrow();
      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Storage API not available"),
      );
    });
  });
});

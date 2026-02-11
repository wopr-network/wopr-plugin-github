import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  WOPRPluginContext,
  GitHubConfig,
  GitHubExtension,
  WebhookEvent,
} from "../src/types.js";

// Mock child_process before importing the plugin
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execSync, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

// Dynamic import to ensure mocks are in place
const { default: plugin } = await import("../src/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecSync(returnValue: string) {
  vi.mocked(execSync).mockReturnValue(returnValue);
}

function mockExecSyncError(message: string) {
  vi.mocked(execSync).mockImplementation(() => {
    const err: any = new Error(message);
    err.stderr = message;
    throw err;
  });
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
  };
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
      // "which gh" succeeds, "gh auth status" fails
      vi.mocked(execSync)
        .mockReturnValueOnce("/usr/bin/gh" as any) // which gh
        .mockImplementationOnce(() => {
          throw new Error("not logged in");
        }); // gh auth status

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
      // list hooks returns existing webhook ID
      mockSpawnSync("12345");

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

      // auth check succeeds
      mockExecSync("ok");
      // First spawnSync: list hooks returns empty (no existing hook)
      // Second spawnSync: create hook returns new ID
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

      mockExecSync("ok"); // auth
      // list: no existing, create: fails
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
});

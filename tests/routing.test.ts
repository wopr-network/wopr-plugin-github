import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubConfig, GitHubExtension, WOPRPluginContext } from "../src/types.js";

// Mock child_process before importing the plugin
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  unlinkSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

function mockSpawnSyncSuccess(stdout = "") {
  vi.mocked(spawnSync).mockReturnValue({
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    pid: 1234,
    output: [null, stdout, ""],
    error: undefined,
  } as SpawnSyncReturns<string>);
}

let extensions: Record<string, unknown> = {};

function makeCtx(config?: GitHubConfig): WOPRPluginContext {
  extensions = {};
  const ctx: Record<string, unknown> = {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getConfig<T>() {
      return config as T | undefined;
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
  return ctx as unknown as WOPRPluginContext;
}

function getGitHubExtension(): GitHubExtension {
  return extensions["github"] as GitHubExtension;
}

// Dynamic import to ensure mocks are in place
const { default: plugin } = await import("../src/index.js");

describe("webhook routing", () => {
  beforeEach(async () => {
    // Ensure clean shutdown before each test
    try {
      await plugin.shutdown?.();
    } catch {
      // ignore if not initialized
    }
    // Mock gh auth check as success
    mockSpawnSyncSuccess("");
  });

  it("routes pull_request events to configured routing table session", async () => {
    const ctx = makeCtx({
      routing: { pull_request: "code-review", "*": "default" },
    });
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const result = ext.handleWebhook({
      eventType: "pull_request",
      payload: {},
    });
    expect(result).toEqual({ routed: true, session: "code-review" });
  });

  it("falls back to wildcard route when event not in routing table", async () => {
    const ctx = makeCtx({
      routing: { pull_request: "code-review", "*": "catch-all" },
    });
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const result = ext.handleWebhook({
      eventType: "push",
      payload: {},
    });
    expect(result).toEqual({ routed: true, session: "catch-all" });
  });

  it("returns not-routed when no route matches and no wildcard", async () => {
    const ctx = makeCtx({
      routing: { pull_request: "code-review" },
    });
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const result = ext.handleWebhook({
      eventType: "push",
      payload: {},
    });
    expect(result.routed).toBe(false);
  });

  it("returns not-routed with missing event type", async () => {
    const ctx = makeCtx({
      routing: { "*": "default" },
    });
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const result = ext.handleWebhook({ payload: {} });
    expect(result).toEqual({ routed: false, reason: "Missing event type" });
  });

  it("uses legacy prReviewSession for pull_request events when no routing table", async () => {
    const ctx = makeCtx({
      prReviewSession: "legacy-pr-session",
    });
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const result = ext.handleWebhook({
      eventType: "pull_request",
      payload: {},
    });
    expect(result).toEqual({ routed: true, session: "legacy-pr-session" });
  });

  it("returns not-routed when config is empty", async () => {
    const ctx = makeCtx({});
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const result = ext.handleWebhook({
      eventType: "push",
      payload: {},
    });
    expect(result.routed).toBe(false);
  });

  it("resolveSession returns the correct session for a mapped event", async () => {
    const ctx = makeCtx({
      routing: { issues: "project-mgmt" },
    });
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    expect(ext.resolveSession("issues")).toBe("project-mgmt");
  });

  it("resolveSession returns null when no config matches", async () => {
    const ctx = makeCtx({});
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    expect(ext.resolveSession("push")).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubConfig, GitHubExtension, WOPRPluginContext } from "../src/types.js";
import type { PluginStorageAPI } from "../src/storage.js";

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

let extensions: Record<string, unknown> = {};

function makeCtx(config?: GitHubConfig, storage?: PluginStorageAPI): WOPRPluginContext {
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
  if (storage) {
    (ctx as Record<string, unknown>).storage = storage;
  }
  return ctx as unknown as WOPRPluginContext;
}

function getGitHubExtension(): GitHubExtension {
  return extensions["github"] as GitHubExtension;
}

// Dynamic import to ensure mocks are in place
const { default: plugin } = await import("../src/index.js");

describe("subscriptions", () => {
  beforeEach(async () => {
    try {
      await plugin.shutdown?.();
    } catch {
      // ignore if not initialized
    }
    mockSpawnSyncSuccess("");
  });

  it("listSubscriptions returns empty array when no subscriptions loaded", async () => {
    const ctx = makeCtx({});
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    expect(ext.listSubscriptions()).toEqual([]);
  });

  it("listWatchedRepos returns empty array when no subscriptions loaded", async () => {
    const ctx = makeCtx({});
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    expect(ext.listWatchedRepos()).toEqual([]);
  });

  it("resolveSession returns null with no config", async () => {
    const ctx = makeCtx(undefined);
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    expect(ext.resolveSession("push")).toBeNull();
  });

  it("loads subscriptions from config on first-time setup when storage is available", async () => {
    const storageMock = makeStorageMock();
    const ctx = makeCtx(
      {
        subscriptions: {
          "owner/repo": {
            repo: "owner/repo",
            webhookId: 42,
            events: ["push"],
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        },
      },
      storageMock,
    );
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const subs = ext.listSubscriptions();
    // Config-embedded subscriptions are loaded and migrated to storage
    expect(subs).toHaveLength(1);
    expect(subs[0].repo).toBe("owner/repo");
    expect(subs[0].webhookId).toBe(42);
  });

  it("listWatchedRepos maps subscriptions to WatchedRepoInfo shape", async () => {
    const storageMock = makeStorageMock();
    const ctx = makeCtx(
      {
        subscriptions: {
          "acme/widget": {
            repo: "acme/widget",
            webhookId: 99,
            events: ["push", "pull_request"],
            session: "my-session",
            createdAt: "2024-06-15T12:00:00.000Z",
          },
        },
      },
      storageMock,
    );
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    const watched = ext.listWatchedRepos();
    expect(watched).toHaveLength(1);
    expect(watched[0]).toMatchObject({
      repo: "acme/widget",
      webhookId: 99,
      events: ["push", "pull_request"],
      session: "my-session",
      createdAt: "2024-06-15T12:00:00.000Z",
    });
  });

  it("resolveSession respects subscription session override for repo-specific routing", async () => {
    const storageMock = makeStorageMock();
    const ctx = makeCtx(
      {
        routing: { pull_request: "global-session" },
        subscriptions: {
          "owner/repo": {
            repo: "owner/repo",
            webhookId: 1,
            events: ["pull_request"],
            session: "repo-specific-session",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        },
      },
      storageMock,
    );
    await plugin.init?.(ctx);

    const ext = getGitHubExtension();
    // Subscription-level session override: event from owner/repo should use repo-specific-session
    const result = ext.handleWebhook({
      eventType: "pull_request",
      payload: { repository: { full_name: "owner/repo" } },
    });
    expect(result).toEqual({ routed: true, session: "repo-specific-session" });
  });
});

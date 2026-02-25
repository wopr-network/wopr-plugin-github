import type { WOPRPluginContext } from "@wopr-network/plugin-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("wopr-plugin-github", () => {
	describe("plugin exports", () => {
		it("should export default plugin", async () => {
			const mod = await import("./index.js");
			expect(mod.default).toBeDefined();
			expect(mod.default.name).toBe("wopr-plugin-github");
		});

		it("should export GitHubExtension type and extension object has expected methods", async () => {
			const mod = await import("./index.js");
			const plugin = mod.default;
			// Verify the extension will have the expected shape by checking after init
			const registerExtension = vi.fn();
			const unregisterExtension = vi.fn();
			const ctx = {
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				getConfig: vi.fn().mockReturnValue(undefined),
				getMainConfig: vi.fn(),
				registerExtension,
				unregisterExtension,
				getExtension: vi.fn().mockReturnValue(null),
			} as unknown as WOPRPluginContext;
			await plugin.init?.(ctx);
			const ext = registerExtension.mock.calls[0]?.[1];
			expect(ext).toBeDefined();
			expect(typeof ext.setupWebhook).toBe("function");
			expect(typeof ext.getWebhookUrl).toBe("function");
			expect(typeof ext.isAuthenticated).toBe("function");
			await plugin.shutdown?.();
		});
	});

	describe("WOPRPlugin interface", () => {
		it("should have required properties", async () => {
			const { default: plugin } = await import("./index.js");
			expect(plugin.name).toBe("wopr-plugin-github");
			expect(plugin.version).toBeDefined();
			expect(plugin.version).toBe("1.0.0");
			expect(plugin.description).toBeDefined();
		});

		it("should have config schema", async () => {
			const { default: plugin } = await import("./index.js");
			expect(plugin.configSchema).toBeDefined();
			expect(plugin.configSchema?.title).toBe("GitHub Integration");
		});

		it("should have commands", async () => {
			const { default: plugin } = await import("./index.js");
			expect(plugin.commands).toBeDefined();
			expect(plugin.commands?.length).toBeGreaterThan(0);
		});
	});

	describe("init/shutdown contract", () => {
		beforeEach(() => {
			vi.resetModules();
		});

		it("init() registers the github extension with ctx", async () => {
			const { default: plugin } = await import("./index.js");
			const registerExtension = vi.fn();
			const ctx = {
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				getConfig: vi.fn().mockReturnValue(undefined),
				getMainConfig: vi.fn(),
				registerExtension,
				unregisterExtension: vi.fn(),
				getExtension: vi.fn().mockReturnValue(null),
			} as unknown as WOPRPluginContext;

			await plugin.init?.(ctx);

			expect(registerExtension).toHaveBeenCalledWith(
				"github",
				expect.any(Object),
			);
			await plugin.shutdown?.();
		});

		it("shutdown() unregisters the github extension", async () => {
			const { default: plugin } = await import("./index.js");
			const unregisterExtension = vi.fn();
			const ctx = {
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				getConfig: vi.fn().mockReturnValue(undefined),
				getMainConfig: vi.fn(),
				registerExtension: vi.fn(),
				unregisterExtension,
				getExtension: vi.fn().mockReturnValue(null),
			} as unknown as WOPRPluginContext;

			await plugin.init?.(ctx);
			await plugin.shutdown?.();

			expect(unregisterExtension).toHaveBeenCalledWith("github");
		});

		it("shutdown() is idempotent (safe to call twice)", async () => {
			const { default: plugin } = await import("./index.js");
			const ctx = {
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				getConfig: vi.fn().mockReturnValue(undefined),
				getMainConfig: vi.fn(),
				registerExtension: vi.fn(),
				unregisterExtension: vi.fn(),
				getExtension: vi.fn().mockReturnValue(null),
			} as unknown as WOPRPluginContext;

			await plugin.init?.(ctx);
			await expect(plugin.shutdown?.()).resolves.not.toThrow();
			await expect(plugin.shutdown?.()).resolves.not.toThrow();
		});
	});
});

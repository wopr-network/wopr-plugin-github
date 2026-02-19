import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { validateOrg, setupOrgWebhook } from "../src/index.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(actual.spawnSync),
	};
});

describe("validateOrg", () => {
	it("accepts valid org names", () => {
		expect(validateOrg("wopr-network")).toBe(true);
		expect(validateOrg("my.org")).toBe(true);
		expect(validateOrg("org_name")).toBe(true);
		expect(validateOrg("a")).toBe(true);
		// 39-char string (max GitHub username/org length)
		expect(validateOrg("a".repeat(39))).toBe(true);
	});

	it("rejects invalid org names", () => {
		expect(validateOrg("")).toBe(false);
		expect(validateOrg("../repos/victim")).toBe(false);
		expect(validateOrg("my org")).toBe(false);
		expect(validateOrg("org;rm -rf /")).toBe(false);
		expect(validateOrg("-leadinghyphen")).toBe(false);
		expect(validateOrg("trailinghyphen-")).toBe(false);
		// 40-char string (exceeds max)
		expect(validateOrg("a".repeat(40))).toBe(false);
	});
});

describe("setupOrgWebhook", () => {
	it("returns failure for invalid org without calling gh", async () => {
		const mockSpawnSync = vi.mocked(spawnSync);
		mockSpawnSync.mockClear();

		const result = await setupOrgWebhook("../evil");

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid org name");
		// spawnSync should NOT have been called -- validation rejects before any gh call
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});
});

describe("structural checks", () => {
	it("does not use execSync in src/index.ts", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "src", "index.ts"),
			"utf-8",
		);
		expect(source).not.toContain("execSync");
	});
});

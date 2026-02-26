import { describe, expect, it } from "vitest";

// Dynamic import
const { default: plugin } = await import("../src/index.js");

describe("plugin manifest", () => {
  it("has a manifest object", () => {
    expect(plugin.manifest).toBeDefined();
  });

  it("manifest has capabilities array", () => {
    expect(Array.isArray(plugin.manifest?.capabilities)).toBe(true);
    expect(plugin.manifest!.capabilities.length).toBeGreaterThan(0);
  });

  it("manifest has a category", () => {
    expect(typeof plugin.manifest?.category).toBe("string");
    expect(plugin.manifest!.category!.length).toBeGreaterThan(0);
  });

  it("manifest has tags array", () => {
    expect(Array.isArray(plugin.manifest?.tags)).toBe(true);
    expect(plugin.manifest!.tags!.length).toBeGreaterThan(0);
  });

  it("manifest has an icon", () => {
    expect(typeof plugin.manifest?.icon).toBe("string");
    expect(plugin.manifest!.icon!.length).toBeGreaterThan(0);
  });

  it("manifest has requires with bins", () => {
    expect(plugin.manifest?.requires).toBeDefined();
    expect(Array.isArray(plugin.manifest?.requires?.bins)).toBe(true);
    expect(plugin.manifest!.requires!.bins).toContain("gh");
  });

  it("manifest has lifecycle object", () => {
    expect(plugin.manifest?.lifecycle).toBeDefined();
  });
});

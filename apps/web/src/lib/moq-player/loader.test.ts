import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	document.querySelectorAll("script[data-bitovp-moq]").forEach((node) => {
		node.remove();
	});
	Reflect.deleteProperty(window, "bitmovin");
	vi.resetModules();
});
describe("fixed local MoQ player loader", () => {
	it("loads the authenticated local route once, then shares the verified factory", async () => {
		const { loadMoqPlayer } = await import("./loader");
		const factory = vi.fn();
		const first = loadMoqPlayer();
		const second = loadMoqPlayer();
		expect(second).toBe(first);
		const scripts = document.querySelectorAll<HTMLScriptElement>(
			"script[data-bitovp-moq]",
		);
		expect(scripts).toHaveLength(1);
		const script = scripts.item(0);
		if (!script) throw new Error("expected one player script");
		expect(script.getAttribute("src")).toBe("/api/player-assets/moq");
		Object.assign(window, { bitmovin: { playerx: { Player: factory } } });
		script.dispatchEvent(new Event("load"));
		expect(await first).toBe(factory);
		expect(await loadMoqPlayer()).toBe(factory);
	});
	it("retries a failed asset load and never adopts a preexisting unverified global", async () => {
		Object.assign(window, { bitmovin: { playerx: { Player: vi.fn() } } });
		const { loadMoqPlayer } = await import("./loader");
		const first = loadMoqPlayer();
		document
			.querySelector("script[data-bitovp-moq]")
			?.dispatchEvent(new Event("error"));
		await expect(first).rejects.toThrow(/^MoQ player unavailable$/);
		const second = loadMoqPlayer();
		expect(second).not.toBe(first);
		expect(document.querySelectorAll("script[data-bitovp-moq]")).toHaveLength(
			1,
		);
		const verified = vi.fn();
		Object.assign(window, { bitmovin: { playerx: { Player: verified } } });
		document
			.querySelector("script[data-bitovp-moq]")
			?.dispatchEvent(new Event("load"));
		await expect(second).resolves.toBe(verified);
	});
	it("rejects an asset that leaves an unrelated preexisting Player factory unchanged", async () => {
		Object.assign(window, { bitmovin: { playerx: { Player: vi.fn() } } });
		const { loadMoqPlayer } = await import("./loader");
		const loaded = loadMoqPlayer();
		document
			.querySelector("script[data-bitovp-moq]")
			?.dispatchEvent(new Event("load"));
		await expect(loaded).rejects.toThrow(/^MoQ player unavailable$/);
	});
	it("rejects a loaded asset without a Player factory using a fixed safe error", async () => {
		const { loadMoqPlayer } = await import("./loader");
		const loaded = loadMoqPlayer();
		document
			.querySelector("script[data-bitovp-moq]")
			?.dispatchEvent(new Event("load"));
		await expect(loaded).rejects.toThrow(/^MoQ player unavailable$/);
	});
});

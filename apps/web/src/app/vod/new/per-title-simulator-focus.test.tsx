import { describe, expect, it, vi } from "vitest";
import { focusPerTitleSetting } from "./per-title-simulator-focus";

describe("evaluation links to simulator settings", () => {
	it("opens nested details and focuses the value, rather than its adjustment mode", () => {
		document.body.innerHTML = `<main><details><summary>Global</summary><details><summary>Spacing</summary><div data-setting-scope="global" data-setting-key="maxBitrateStepSize" data-setting-control="spacing"><select aria-label="Adjustment"><option>Fixed</option></select><input id="spacing" type="number" value="2"></div></details></details></main>`;
		const root = document.querySelector("main");
		const target = document.getElementById("spacing");
		if (!target) throw new Error("Expected the setting input.");
		const scroll = vi.fn();
		target.scrollIntoView = scroll;
		expect(
			focusPerTitleSetting(root, {
				scope: "global",
				key: "maxBitrateStepSize",
			}),
		).toBe(true);
		expect(document.activeElement).toBe(target);
		expect(
			[...document.querySelectorAll("details")].every((el) => el.open),
		).toBe(true);
		expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
	});

	it("distinguishes global bounds, repeated stream fields and another simulator", () => {
		document.body.innerHTML = `<section><div data-setting-scope="stream" data-setting-key="minBitrate" data-setting-row="second" data-setting-control="elsewhere"><input id="elsewhere"></div></section><main><div data-setting-scope="global" data-setting-key="minBitrate" data-setting-control="global"><input id="global"></div><div data-setting-scope="stream" data-setting-key="minBitrate" data-setting-row="first" data-setting-control="first"><input id="first"></div><div data-setting-scope="stream" data-setting-key="minBitrate" data-setting-row="second" data-setting-control="second"><input id="second"></div></main>`;
		expect(
			focusPerTitleSetting(document.querySelector("main"), {
				scope: "stream",
				key: "minBitrate",
				rowId: "second",
			}),
		).toBe(true);
		expect(document.activeElement).toBe(document.getElementById("second"));
	});

	it("focuses the count policy without changing it", () => {
		document.body.innerHTML = `<main><div data-setting-scope="global" data-setting-key="countPolicy" data-setting-control="count"><select id="count"><option value="unrestricted">Automatic</option><option value="exact">Exact</option></select></div></main>`;
		const target = document.getElementById("count") as HTMLSelectElement;
		expect(
			focusPerTitleSetting(document.querySelector("main"), {
				scope: "global",
				key: "countPolicy",
			}),
		).toBe(true);
		expect(document.activeElement).toBe(target);
		expect(target.value).toBe("unrestricted");
	});

	it("does not focus another setting when a target is absent or disabled", () => {
		document.body.innerHTML = `<main><button id="existing">Existing focus</button><div data-setting-scope="global" data-setting-key="maxBitrate" data-setting-control="disabled"><input id="disabled" disabled></div></main>`;
		const active = document.getElementById("existing");
		active?.focus();
		const root = document.querySelector("main");
		expect(
			focusPerTitleSetting(root, {
				scope: "stream",
				key: "minBitrate",
				rowId: "absent",
			}),
		).toBe(false);
		expect(
			focusPerTitleSetting(root, { scope: "global", key: "maxBitrate" }),
		).toBe(false);
		expect(
			focusPerTitleSetting(null, { scope: "global", key: "maxBitrate" }),
		).toBe(false);
		expect(document.activeElement).toBe(active);
	});
});

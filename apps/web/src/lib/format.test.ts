import { describe, expect, it } from "vitest";
import { baseName, formatBytes, prefixCrumbs } from "./format";

describe("formatBytes", () => {
	it("scales units", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});

describe("prefixCrumbs", () => {
	it("builds cumulative crumb paths", () => {
		expect(prefixCrumbs("")).toEqual([]);
		expect(prefixCrumbs("videos/raw/")).toEqual(["videos/", "videos/raw/"]);
	});
});

describe("baseName", () => {
	it("handles objects and prefixes", () => {
		expect(baseName("videos/raw/a.mp4")).toBe("a.mp4");
		expect(baseName("videos/raw/")).toBe("raw");
		expect(baseName("a.mp4")).toBe("a.mp4");
	});
});

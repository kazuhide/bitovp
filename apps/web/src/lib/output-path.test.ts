import { describe, expect, it } from "vitest";
import {
	joinOutputName,
	renameOutputBase,
	splitOutputFolder,
} from "./output-path";

describe("joinOutputName", () => {
	it("joins folder and name with a single slash", () => {
		expect(joinOutputName("output", "chan")).toBe("output/chan");
	});
	it("trims a trailing slash on the folder and stray slashes on the name", () => {
		expect(joinOutputName("output/", "chan")).toBe("output/chan");
		expect(joinOutputName("output", "/chan/")).toBe("output/chan");
	});
	it("degrades to just one side when the other is empty", () => {
		expect(joinOutputName("", "chan")).toBe("chan");
		expect(joinOutputName("output", "")).toBe("output");
		expect(joinOutputName("", "")).toBe("");
	});
});

describe("splitOutputFolder", () => {
	it("recovers the folder when the base ends with /name", () => {
		expect(splitOutputFolder("output/chan", "chan")).toBe("output");
		expect(splitOutputFolder("a/b/chan", "chan")).toBe("a/b");
	});
	it("returns an empty folder when the base IS the name", () => {
		expect(splitOutputFolder("chan", "chan")).toBe("");
	});
	it("returns null when the base does not follow the name-suffix pattern", () => {
		// Imported/hand-set paths whose tail is not the name → caller shows base as-is.
		expect(
			splitOutputFolder(
				"output/live-rtmp-simple",
				"Live RTMP Channel (live-rtmp-simple)",
			),
		).toBeNull();
		expect(splitOutputFolder("output/channel", "chan")).toBeNull();
	});
	it("treats an empty name as 'no suffix' and returns the whole base", () => {
		expect(splitOutputFolder("output/x", "")).toBe("output/x");
	});
});

describe("renameOutputBase", () => {
	it("re-namespaces a base that follows the folder/oldName shape", () => {
		expect(renameOutputBase("output/old", "old", "new")).toBe("output/new");
		expect(renameOutputBase("old", "old", "new")).toBe("new");
	});
	it("leaves a hand-set / divergent base untouched", () => {
		expect(renameOutputBase("output/custom", "old", "new")).toBe(
			"output/custom",
		);
	});
});

describe("join/split round-trip", () => {
	it("split inverts join for sane folder/name pairs", () => {
		for (const [folder, name] of [
			["output", "chan"],
			["a/b/c", "my-channel"],
			["", "solo"],
		] as const) {
			expect(splitOutputFolder(joinOutputName(folder, name), name)).toBe(
				folder,
			);
		}
	});
});

it("renames copied manifest bases with a trailing slash", () => {
	expect(splitOutputFolder("exports/source/", "source")).toBe("exports");
	expect(renameOutputBase("exports/source/", "source", "new")).toBe(
		"exports/new/",
	);
	expect(renameOutputBase("source/", "source", "new")).toBe("new/");
	expect(renameOutputBase("exports/custom/", "source", "new")).toBe(
		"exports/custom/",
	);
});

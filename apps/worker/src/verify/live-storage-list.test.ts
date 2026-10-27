import { expect, it, vi } from "vitest";
import { listLiveOutputObjects } from "./live-storage-list";

it("requests recursive pages and preserves object metadata", async () => {
	const listObjects = vi.fn(
		async (input: { recursive?: boolean; cursor?: string }) => ({
			prefixes: input.recursive ? [] : ["out/media/"],
			objects: input.recursive
				? [
						{
							key: `out/media/${input.cursor ? 2 : 1}.m4s`,
							size: 2000,
							lastModified: "2026-10-27T00:00:00.000Z",
						},
					]
				: [],
			...(!input.cursor ? { nextCursor: "next" } : {}),
		}),
	);
	const objects = await listLiveOutputObjects(
		{ listObjects },
		"bucket",
		"out/",
	);
	expect(objects.map((o) => o.key)).toEqual([
		"out/media/1.m4s",
		"out/media/2.m4s",
	]);
	expect(
		objects.every((o) => o.lastModified === "2026-10-27T00:00:00.000Z"),
	).toBe(true);
	expect(
		listObjects.mock.calls.every(([input]) => input.recursive === true),
	).toBe(true);
});

it("refuses an incomplete recursive listing rather than ignoring child prefixes", async () => {
	await expect(
		listLiveOutputObjects(
			{ listObjects: async () => ({ prefixes: ["out/media/"], objects: [] }) },
			"bucket",
			"out/",
		),
	).rejects.toThrow(/recursive/);
});

it("bounds a nonterminating paginated listing", async () => {
	const listObjects = vi.fn(async () => ({
		prefixes: [],
		objects: [],
		nextCursor: "repeated",
	}));
	await expect(
		listLiveOutputObjects({ listObjects }, "bucket", "out/"),
	).rejects.toThrow(/listing/);
	expect(listObjects.mock.calls.length).toBeLessThanOrEqual(40);
});

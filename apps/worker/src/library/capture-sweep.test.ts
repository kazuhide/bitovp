import type { AppPrismaClient } from "@bitovp/db";
import { expect, it, vi } from "vitest";
import { createLibraryCaptureSweep } from "./capture-sweep";

it("captures bounded finished history, continues after an invalid legacy job, and resets the cursor", async () => {
	const findMany = vi
		.fn()
		.mockResolvedValueOnce([
			{ id: "a", plan: {}, librarySources: [] },
			{ id: "b", plan: {}, librarySources: [] },
		])
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([]);
	const capture = vi
		.fn()
		.mockRejectedValueOnce(new Error("invalid plan"))
		.mockResolvedValueOnce({});
	const tick = createLibraryCaptureSweep({
		prisma: { encodingJob: { findMany } } as unknown as AppPrismaClient,
		capture,
	});
	await tick();
	await tick();
	await tick();
	expect(capture).toHaveBeenCalledTimes(2);
	expect(findMany.mock.calls[0]?.[0]).toMatchObject({
		where: { status: "FINISHED", libraryCaptureSuppressed: false },
		take: 25,
	});
	expect(findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: "b" });
	expect(findMany.mock.calls[2]?.[0].where.id).toBeUndefined();
});

it("skips exact registered assets but captures changed encoding identity and legacy missing locators", async () => {
	const hash = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const row = (
		id: string,
		plan: unknown,
		encoding: string,
		storedEncoding: string,
		snapshot = {},
	) => ({
		id,
		plan,
		bitmovinEncodingId: encoding,
		librarySources: [
			{
				sourceKey: hash([id, storedEncoding, hash(plan)]),
				snapshot,
				revisions: [{ id: "revision" }],
			},
		],
	});
	const findMany = vi
		.fn()
		.mockResolvedValue([
			row("exact", {}, "one", "one"),
			row("changed", {}, "two", "one"),
			row("legacy", { aiSceneAnalysis: {} }, "one", "one"),
		]);
	const capture = vi.fn().mockResolvedValue({});
	await createLibraryCaptureSweep({
		prisma: { encodingJob: { findMany } } as unknown as AppPrismaClient,
		capture,
	})();
	expect(capture.mock.calls.map((args) => args[1])).toEqual([
		"changed",
		"legacy",
	]);
});

import { createHash } from "node:crypto";

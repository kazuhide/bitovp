import { expect, it } from "vitest";
import { publicVmafProgress, publicVmafTasks } from "./vmaf-task-progress";

const now = new Date("2026-09-25T00:00:00Z");
it("only projects safe scoring progress, rejecting unknown phases and malformed counts", () => {
	expect(
		publicVmafProgress({
			version: 1,
			phase: "SCORING",
			updatedAt: now.toISOString(),
			framesProcessed: 500,
			totalFrames: 1000,
			image: "private",
			url: "secret",
		}),
	).toEqual({
		phase: "SCORING",
		updatedAt: now.toISOString(),
		framesProcessed: 500,
		totalFrames: 1000,
	});
	expect(
		publicVmafProgress({
			version: 1,
			phase: "https://secret",
			updatedAt: now.toISOString(),
		}),
	).toBeNull();
	expect(
		publicVmafProgress({ version: 1, phase: "SCORING", updatedAt: "bad" }),
	).toBeNull();
	expect(
		publicVmafProgress({
			version: 1,
			phase: "ALIGNMENT",
			updatedAt: now.toISOString(),
			framesProcessed: 20,
			totalFrames: 30,
		}),
	).not.toHaveProperty("framesProcessed");
	expect(
		publicVmafProgress({
			version: 1,
			phase: "SCORING",
			updatedAt: now.toISOString(),
			framesProcessed: -1,
			totalFrames: Infinity,
		}),
	).not.toHaveProperty("totalFrames");
});
it("selects the highest attempt even if cleanup updates the old task later", () => {
	const task = {
		id: "old",
		targetKey: "pair",
		attempt: 0,
		profileId: "gcp",
		state: "CLEANED",
		reservedUsd: 1,
		createdAt: now,
		cleanedAt: now,
		error: null,
		progress: {
			version: 1,
			phase: "SCORING",
			updatedAt: now.toISOString(),
			provisioningModel: "SPOT",
		},
	};
	const result = publicVmafTasks([
		{
			...task,
			id: "new",
			attempt: 1,
			state: "RUNNING",
			cleanedAt: null,
			progress: {
				version: 1,
				phase: "QUEUED",
				updatedAt: now.toISOString(),
				provisioningModel: "STANDARD",
				url: "secret",
			},
		},
		task,
	]);
	expect(
		result.map((t) => [t.id, t.current, t.attempt, t.provisioningModel]),
	).toEqual([
		["new", true, 2, "STANDARD"],
		["old", false, 1, "SPOT"],
	]);
	expect(JSON.stringify(result)).not.toContain("secret");
});

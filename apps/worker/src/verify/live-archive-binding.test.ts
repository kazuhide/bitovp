import { readFileSync } from "node:fs";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	type StepLogEntry,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { bindLiveArchive } from "./live-archive-binding";

export function archiveFixture() {
	const raw = JSON.parse(
		readFileSync(
			new URL(
				"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	raw.muxings.push({
		key: "archive",
		kind: "MP4",
		streamKey: "v1080",
		additionalStreamKeys: ["a128"],
		filename: "archive.mp4",
		destination: { outputKey: "origin", path: "verification/archive" },
	});
	const plan = liveChannelPlanSchema.parse(raw);
	const steps = compileLiveChannel(plan).map((s) => ({
		...s,
		status: "DONE",
		resourceId: `id-${s.step}`,
	})) as StepLogEntry[];
	return { plan, steps };
}

describe("archive attribution", () => {
	it.each([
		"",
		"/",
	])("binds a valid bucket-root archive path %j without a leading key slash", (path) => {
		const { plan } = archiveFixture();
		const muxing = plan.muxings.find((m) => m.key === "archive");
		if (!muxing?.destination) throw new Error("missing archive destination");
		muxing.destination.path = path;
		expect(
			validateLiveChannel(plan).filter((i) => i.level === "error"),
		).toEqual([]);
		const steps = compileLiveChannel(plan).map((s) => ({
			...s,
			status: "DONE",
			resourceId: `id-${s.step}`,
		})) as StepLogEntry[];
		expect(
			bindLiveArchive(plan, steps, "id-encoding", "archive", "origin"),
		).toMatchObject({
			outputPath: "",
			key: "archive.mp4",
		});
	});
	it.each([
		"..",
		"archive/../other",
		"/../",
	])("still rejects traversal path %j", (path) => {
		const { plan } = archiveFixture();
		const muxing = plan.muxings.find((m) => m.key === "archive");
		if (!muxing?.destination) throw new Error("missing archive destination");
		muxing.destination.path = path;
		const steps = compileLiveChannel(plan).map((s) => ({
			...s,
			status: "DONE",
			resourceId: `id-${s.step}`,
		})) as StepLogEntry[];
		expect(() =>
			bindLiveArchive(plan, steps, "id-encoding", "archive", "origin"),
		).toThrow();
	});
	it("binds exactly the supplied run encoding, muxing, streams and storage destination", () => {
		const { plan, steps } = archiveFixture();
		expect(
			bindLiveArchive(plan, steps, "id-encoding", "archive", "origin"),
		).toMatchObject({
			key: "verification/archive/archive.mp4",
			muxingId: "id-muxing:archive",
			streamIds: ["id-stream:v1080", "id-stream:a128"],
			codecs: ["h264", "aac"],
		});
	});
	it.each([
		"different-encoding",
		"missing-stream",
		"wrong-file",
		"wrong-output",
		"duplicate-muxing",
	])("refuses %s before any storage read", (kind) => {
		const { plan, steps } = archiveFixture();
		const entry = (key: string) => {
			const value = steps.find((s) => s.step === key);
			if (!value) throw new Error("missing fixture step");
			return value;
		};
		if (kind === "different-encoding") entry("encoding").resourceId = "other";
		if (kind === "missing-stream")
			steps.splice(
				steps.findIndex((s) => s.step === "stream:a128"),
				1,
			);
		if (kind === "wrong-file")
			entry("muxing:archive").payload.filename = "other.mp4";
		if (kind === "wrong-output")
			entry("output:origin").payload.bucketName = "other";
		if (kind === "duplicate-muxing")
			steps.push(structuredClone(entry("muxing:archive")));
		expect(() =>
			bindLiveArchive(plan, steps, "id-encoding", "archive", "origin"),
		).toThrow();
	});
});

import {
	compileLiveChannel,
	liveChannelPlanSchema,
	rebaseLivePlanForRun,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { audioKeys, videoKeys } from "@/app/vod/new/build-plan";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";

function state(): LiveWizardState {
	const s = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	s.name = "Archive channel";
	s.start.streamKey = "disposabletest";
	s.output = {
		...s.output,
		credentialId: "00000000-0000-4000-8000-000000000001",
		bucket: "media",
		basePath: "live/test",
	};
	return s;
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing test fixture");
	return value;
}

function archived(): LiveWizardState & {
	archive: NonNullable<LiveWizardState["archive"]>;
} {
	const s = state();
	return {
		...s,
		archive: {
			muxing: {
				key: "archive",
				kind: "MP4",
				streamKey: required(videoKeys(s.videos)[0]),
				additionalStreamKeys: [required(audioKeys(s.audios)[0])],
				filename: "archive.mp4",
				destination: { outputKey: "archive-output", path: "live/test/archive" },
			},
			output: { ...s.output, name: "Archive storage", publicRead: false },
		},
	};
}

describe("Live wizard progressive MP4 archive", () => {
	it("is off by default without changing segmented delivery", () => {
		expect(
			buildLiveChannelPlan(state()).muxings.some((m) => m.kind === "MP4"),
		).toBe(false);
	});
	it("adds a storage archive using the same existing video and audio streams", () => {
		const s = archived();
		const before = buildLiveChannelPlan(state());
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
		expect(p.muxings.at(-1)).toEqual(s.archive?.muxing);
		expect(p.renditions).toHaveLength(before.renditions.length);
		expect(p.outputs.at(-1)).toMatchObject({
			key: "archive-output",
			kind: "S3",
			bucket: "media",
		});
		expect(p.liveManifests).toEqual(
			liveChannelPlanSchema.parse(before).liveManifests,
		);
		expect(validateLiveChannel(p).filter((i) => i.level === "error")).toEqual(
			[],
		);
		const ops = compileLiveChannel(p);
		expect(ops.filter((op) => op.kind === "CREATE_ENCODING")).toHaveLength(1);
		expect(
			ops.find((op) => op.kind === "CREATE_MUXING_MP4")?.refs,
		).toMatchObject({
			encodingId: "encoding",
			streamId: "stream:v720",
			additionalStreamIds: ["stream:a128"],
		});
		const rebased = rebaseLivePlanForRun(p, {
			seq: 2,
			runId: "ab12cd34-5678-90ef-1234-567890abcdef",
		});
		expect(rebased.plan.muxings.at(-1)?.destination?.path).toBe(
			"live/test/runs/2-ab12cd34/archive",
		);
	});
	it.each([
		["separate", "PRIVATE"],
		["origin", "PRIVATE"],
		["mirror", "PRIVATE"],
		["separate", "PUBLIC_READ"],
		["origin", "PUBLIC_READ"],
		["mirror", "PUBLIC_READ"],
	] as const)("preserves %s archive destination with %s ACL, filename and stream references on import/duplicate", (target, acl) => {
		const s = archived();
		if (target !== "separate") {
			s.archive.muxing.destination.outputKey =
				target === "origin" ? "origin" : "mirror-1";
			delete s.archive.output;
			if (target === "mirror") s.mirror = { ...s.output, bucket: "mirror" };
		}
		s.archive.muxing.name = "Keep archive name";
		s.archive.muxing.destination.acl = acl;
		s.archive.muxing.filename = "recorded-show.mp4";
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
		expect(planToLiveWizardState(p).archive?.muxing).toEqual(s.archive.muxing);
		expect(
			liveChannelPlanSchema.parse(
				buildLiveChannelPlan(planToLiveWizardState(p)),
			),
		).toEqual(p);
		expect(tryImportLiveChannelIntoWizard(p).ok).toBe(true);
	});
	it("preserves an imported unspecified archive ACL without inheriting public segment ACL", () => {
		const s = archived();
		s.output.publicRead = true;
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
		expect(p.liveManifests[0]?.destination.acl).toBe("PUBLIC_READ");
		expect(p.muxings.at(-1)?.destination?.acl).toBeUndefined();
	});
	it("does not silently discard additional expert-authored archives", () => {
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(archived()));
		p.muxings.push({ ...required(p.muxings.at(-1)), key: "second-archive" });
		expect(tryImportLiveChannelIntoWizard(p).ok).toBe(false);
	});
	it("does not hide multiple archive audio tracks behind a single selector", () => {
		const s = archived();
		s.audios.push({ codec: "AAC", bitrate: 64000, rate: 48000 });
		s.archive.muxing.additionalStreamKeys = ["a128", "a64"];
		expect(tryImportLiveChannelIntoWizard(buildLiveChannelPlan(s)).ok).toBe(
			false,
		);
	});
	it("preserves invalid/dangling archive choices for validation instead of silently removing them", () => {
		const s = archived();
		s.archive.muxing.streamKey = "deleted-rung";
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
		expect(p.muxings.at(-1)?.streamKey).toBe("deleted-rung");
		expect(validateLiveChannel(p).some((i) => i.level === "error")).toBe(true);
	});
});

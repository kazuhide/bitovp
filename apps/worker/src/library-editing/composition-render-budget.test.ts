import {
	compileComposition,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCompositionRenderProgram,
	compositionVideoInputArgs,
} from "./composition-render";

vi.mock("@bitovp/core", async (importOriginal) => {
	const core = await importOriginal<typeof import("@bitovp/core")>();
	return {
		...core,
		evaluateCompositionFrame: vi.fn(core.evaluateCompositionFrame),
	};
});

function fixture(durationFrames: number, count: number) {
	const mediaVersionId = "11111111-1111-4111-8111-111111111111";
	const timeMapId = "22222222-2222-4222-8222-222222222222";
	const document = toCompositionDocument({
		schemaVersion: 1,
		mediaVersionId,
		timeMapId,
		analysisRevisionId: null,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: Array.from({ length: count }, (_, index) => {
			const start = Math.floor((index * durationFrames) / count);
			const end = Math.floor(((index + 1) * durationFrames) / count);
			return {
				id: `33333333-3333-4333-8333-${index.toString().padStart(12, "0")}`,
				sourceInUs: 0,
				durationFrames: end - start,
				timelineStartFrame: start,
				framing: [
					{ fromFrame: 0, toFrame: end - start, mode: "FIT", origin: "MANUAL" },
				],
				audio: { mode: "SOURCE" },
			};
		}),
	});
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
	};
	const sources = [
		{
			mediaVersionId,
			width: 1920,
			height: 1080,
			hasAudio: true,
			timeMap: {
				id: timeMapId,
				mediaVersionId,
				kind: "CFR" as const,
				sourceStartUs: 0,
				sourceEndUs: 180_000_000,
				editingStartFrame: 0,
				editingEndFrame: 5400,
				fps: { num: 30 as const, den: 1 as const },
			},
		},
	];
	return { document, sources };
}

beforeEach(() => {
	vi.mocked(evaluateCompositionFrame).mockClear();
});

describe("bounded composition render planning", () => {
	it.each([
		[450, 6],
		[1800, 13],
		[5400, 20],
	])("streams %i frame video geometry and concatenates %i non-overlapping clips", (frames, clips) => {
		const { document, sources } = fixture(frames, clips);
		const before = structuredClone(document);
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-render-budget",
		);
		expect(evaluateCompositionFrame).not.toHaveBeenCalled();
		expect(program.graph).toContain(`concat=n=${clips}:v=1:a=0`);
		expect(program.graph).not.toContain("blend=all_mode=addition");
		expect(program.graph).not.toContain("tpad=start=");
		expect(program.planningMetrics).toMatchObject({
			videoFrameEvaluations: frames,
			fullFrameEvaluations: 0,
			fullDurationClipBranches: 0,
			concatenatedTracks: 1,
		});
		expect(program.planningMetrics.graphBytes).toBe(
			Buffer.byteLength(program.graph),
		);
		expect(document).toEqual(before);
	});

	it("evaluates caption layout once per cue rather than once per video frame", () => {
		const { document, sources } = fixture(1800, 13);
		document.captions = [
			{
				id: "44444444-4444-4444-8444-444444444444",
				fromFrame: 0,
				toFrame: 1800,
				text: "日本語の長い字幕でも、レイアウトは動画の全フレームで繰り返さない。",
			},
		];
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-render-caption-budget",
		);
		expect(evaluateCompositionFrame).toHaveBeenCalledTimes(1);
		expect(program.planningMetrics.fullFrameEvaluations).toBe(1);
		expect(
			program.files.find((file) => file.name === "captions.ass")?.contents,
		).toContain("日本語");
	});

	it("keeps transparent gaps as exact frame segments rather than extending adjacent clips", () => {
		const { document, sources } = fixture(60, 2);
		const second = document.clips[1];
		if (!second) throw new Error("Missing clip");
		second.timelineStartFrame += 5;
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-render-gaps",
		);
		expect(program.durationFrames).toBe(65);
		expect(program.graph).toContain(
			"color=c=black@0:s=1080x1920:r=30,format=gbrap,trim=end_frame=5",
		);
		expect(program.graph).toContain(
			"[clip0][track0gap1][clip1]concat=n=3:v=1:a=0",
		);
		expect(program.planningMetrics.fullDurationClipBranches).toBe(0);
	});

	it("uses independent integer-second-seeked video inputs so concat cannot buffer a reused source fanout", () => {
		const { document, sources } = fixture(60, 2);
		const first = document.clips[0],
			second = document.clips[1];
		if (!first || !second) throw new Error("Missing clips");
		first.sourceInUs = 13_033_334;
		second.sourceInUs = 3_033_334; // A reverse/reuse order must also be bounded.
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-render-seeks",
		);
		expect(program.videoInputs).toEqual([
			{ mediaVersionId: sources[0]?.mediaVersionId, seekSeconds: 13 },
			{ mediaVersionId: sources[0]?.mediaVersionId, seekSeconds: 3 },
		]);
		expect(program.graph).toContain("[1:v:0]trim=start_frame=1:end_frame=31");
		expect(program.graph).toContain("[2:v:0]trim=start_frame=1:end_frame=31");
		expect(program.graph).not.toContain("[0:v:0]trim=");
		// Original-source audio still uses the unshifted source clock.
		expect(program.graph).toContain(
			"[0:a:0]aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=625600:end_sample=673600",
		);
		const args = compositionVideoInputArgs(program.videoInputs, [
			{
				mediaVersionId: sources[0]?.mediaVersionId ?? "",
				sourcePath: "/tmp/owned-source.mp4",
			},
		]);
		expect(args).toEqual(
			[13, 3].flatMap((seconds) => [
				"-threads",
				"1",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				"mov",
				"-enable_drefs",
				"0",
				"-use_absolute_path",
				"0",
				"-ss",
				String(seconds),
				"-an",
				"-sn",
				"-dn",
				"-i",
				"/tmp/owned-source.mp4",
			]),
		);
		expect(() => compositionVideoInputArgs(program.videoInputs, [])).toThrow(
			"INVALID_RENDER_RECIPE",
		);
	});

	it("keeps the established premultiplied full-duration path for overlapping crossfades", () => {
		const { document, sources } = fixture(60, 2);
		const second = document.clips[1];
		if (!second) throw new Error("Missing clip");
		second.timelineStartFrame = 25;
		second.transitionIn = { type: "CROSSFADE", durationFrames: 5 };
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-render-overlap",
		);
		expect(program.graph).toContain(
			"[clip0][clip1]blend=all_mode=addition:shortest=1",
		);
		expect(program.graph).toContain("tpad=start=25:stop=0");
		expect(program.graph).not.toContain("concat=n=");
		expect(program.planningMetrics).toMatchObject({
			fullDurationClipBranches: 2,
			concatenatedTracks: 0,
		});
	});

	it("concatenates each nonoverlapping track separately and retains source-over PIP composition", () => {
		const { document, sources } = fixture(120, 4);
		document.videoTracks = [
			{ id: "main", name: "Main", order: 0 },
			{ id: "pip", name: "PIP", order: 1 },
		];
		for (const [index, clip] of document.clips.entries()) {
			clip.trackId = index % 2 ? "pip" : "main";
			clip.timelineStartFrame = Math.floor(index / 2) * 60;
			if (index % 2) clip.layout = { x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
		}
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-render-pip",
		);
		expect(program.planningMetrics).toMatchObject({
			fullDurationClipBranches: 0,
			concatenatedTracks: 2,
		});
		expect(program.graph.match(/concat=n=3:v=1:a=0/g)).toHaveLength(2);
		expect(program.graph).toContain("[base0][straight0]overlay=x=0:y=0");
		expect(program.graph).toContain("[base1][straight1]overlay=x=0:y=0");
	});
});

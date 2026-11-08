import { createHash } from "node:crypto";
import {
	compileComposition,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildCompositionRenderProgram } from "./composition-render";

const media = "11111111-1111-4111-8111-111111111111",
	map = "22222222-2222-4222-8222-222222222222",
	clip = "33333333-3333-4333-8333-333333333333",
	next = "44444444-4444-4444-8444-444444444444";
const canvas = { width: 360, height: 640 };
const resources = "/tmp/bitovp-composition-unit";
function fixture() {
	const document = toCompositionDocument({
		schemaVersion: 1,
		mediaVersionId: media,
		timeMapId: map,
		analysisRevisionId: null,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: clip,
				sourceInUs: 0,
				durationFrames: 30,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
				audio: { mode: "SOURCE" },
			},
		],
	});
	const sources = [
		{
			mediaVersionId: media,
			width: 1920,
			height: 1080,
			hasAudio: true,
			timeMap: {
				id: map,
				mediaVersionId: media,
				kind: "CFR" as const,
				sourceStartUs: 0,
				sourceEndUs: 2_000_000,
				editingStartFrame: 0,
				editingEndFrame: 60,
				fps: { num: 30 as const, den: 1 as const },
			},
		},
	];
	return { document, sources };
}
function autoFixture() {
	const result = fixture();
	result.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
	};
	return result;
}

describe("legacy encoder programs pinned before AUTO", () => {
	it.each([
		[
			"MISSING",
			"06f9a804120c0d3f2505be05cc986f717318f76eb0f9fecdebbfe7035ecd0648",
		],
		[
			"FILL",
			"d893a41b487ae6b5d7854df8430f397bdd5ee8c3e256df7e99fa24b2bd4fc02b",
		],
		["FIT", "06f9a804120c0d3f2505be05cc986f717318f76eb0f9fecdebbfe7035ecd0648"],
		[
			"BANDS",
			"d45e1e4ff0f80577507edc3c635b6ea50ed70e4ad3685375eebca002a9393573",
		],
		["PIP", "8ba12284252b349254782471f0b43dd503ded47c557c977ea42505c86ac17632"],
		[
			"CROSSFADE",
			"aa2b1e0a7f67aaa4f3e93f97c0a2dfcc326a321e48306040e225659a5bd32cd8",
		],
	])("keeps all graph and command-file bytes for %s", (mode, expected) => {
		const { document, sources } = fixture();
		if (mode !== "MISSING")
			document.presentation = {
				version: "portrait-layout-v1",
				videoFit: mode === "FIT" ? "FIT" : "FILL",
				captionPlacement: mode === "BANDS" ? "BANDS" : "OVERLAY",
				centerCropConfirmed: true,
			};
		const first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		if (mode === "PIP") first.layout = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
		if (mode === "CROSSFADE")
			document.clips.push({
				...structuredClone(first),
				id: next,
				timelineStartFrame: 20,
				transitionIn: { type: "CROSSFADE", durationFrames: 10 },
			});
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			canvas,
			resources,
		);
		// New structural counters are additive. Keep every existing graph,
		// command, file, canvas and duration byte pinned to the old program.
		const { planningMetrics: _metrics, ...legacyProgram } = program;
		expect(
			createHash("sha256").update(JSON.stringify(legacyProgram)).digest("hex"),
		).toBe(expected);
	});
});

describe("AUTO encoder backdrop", () => {
	it.each([
		"OVERLAY",
		"BANDS",
	] as const)("uses one trimmed source and the shared overscan/crop/shade geometry for %s", (captionPlacement) => {
		const { document, sources } = autoFixture();
		if (!document.presentation) throw new Error("Missing presentation");
		document.presentation.captionPlacement = captionPlacement;
		const plan = compileComposition(document, sources),
			backdrop = evaluateCompositionFrame(plan, 0, canvas).layers[0]?.backdrop;
		if (!backdrop) throw new Error("Missing shared backdrop");
		const { sourceRect: s, drawRect: d, clipRect: c } = backdrop;
		const program = buildCompositionRenderProgram(plan, canvas, resources);
		expect(program.graph.match(/\[0:v:0\]trim=/g)).toHaveLength(1);
		expect(program.graph).toContain(
			"split=2[backdropSource0][foregroundSource0]",
		);
		expect(program.graph).toContain(
			`[backdropSource0]crop=${s.w}:${s.h}:${s.x}:${s.y}:exact=1,scale=${d.w}:${d.h}:flags=lanczos,format=gbrp,gblur=sigma=${backdrop.blurPx}`,
		);
		expect(program.graph).toContain(
			`crop=${c.w}:${c.h}:${c.x - d.x}:${c.y - d.y}:exact=1,format=rgba,pad=360:640:${c.x}:${c.y}:color=black@0[backdrop0]`,
		);
		expect(program.graph).toContain(
			"colorchannelmixer=rr=0.65:gg=0.65:bb=0.65",
		);
		expect(program.graph).toContain("color=black@0:eval=frame");
		expect(program.graph).toContain(
			"[backdrop0][foreground0]overlay=x=0:y=0:format=auto:shortest=1,colorchannelmixer@alpha0=aa=1,format=gbrap,premultiply=inplace=1",
		);
	});

	it("finds a later FIT background without changing dynamic CROP keys or the clip clock", () => {
		const { document, sources } = autoFixture(),
			first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		first.framing = [
			{
				fromFrame: 0,
				toFrame: 10,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0, y: 0, w: 0.31640625, h: 1 },
			},
			{ fromFrame: 10, toFrame: 20, mode: "FIT", origin: "MANUAL" },
			{
				fromFrame: 20,
				toFrame: 30,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0.68359375, y: 0, w: 0.31640625, h: 1 },
			},
		];
		first.cropKeyframes = [
			{ frame: 0, rect: { x: 0, y: 0, w: 0.31640625, h: 1 }, easing: "LINEAR" },
			{
				frame: 29,
				rect: { x: 0.68359375, y: 0, w: 0.31640625, h: 1 },
				easing: "LINEAR",
			},
		];
		const plan = compileComposition(document, sources),
			program = buildCompositionRenderProgram(plan, canvas, resources),
			commands = program.files.find(
				(file) => file.name === "clip-0.cmd",
			)?.contents;
		expect(
			evaluateCompositionFrame(plan, 0, canvas).layers[0]?.backdrop,
		).toBeUndefined();
		expect(program.graph).toContain(
			"split=2[backdropSource0][foregroundSource0]",
		);
		expect(program.graph).toContain(
			"trim=start_frame=0:end_frame=30,settb=1/30,setpts=N",
		);
		expect(commands).toContain(
			"0.333333 crop@crop0 w 1920,crop@crop0 h 1080,crop@crop0 x 0",
		);
		expect(commands).toContain(
			"0.966666 crop@crop0 w 607,crop@crop0 h 1080,crop@crop0 x 1313",
		);
		expect(program.graph).toContain(
			"tpad=start=0:stop=0:start_mode=add:stop_mode=add:color=black@0",
		);
		expect(plan.document.clips[0]?.cropKeyframes).toEqual(first.cropKeyframes);
	});

	it("preserves clip alpha commands and premultiplied crossfade after flattening each background", () => {
		const { document, sources } = autoFixture(),
			first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		first.opacity = 0.5;
		document.clips.push({
			...structuredClone(first),
			id: next,
			timelineStartFrame: 20,
			transitionIn: { type: "CROSSFADE", durationFrames: 10 },
		});
		const plan = compileComposition(document, sources),
			program = buildCompositionRenderProgram(plan, canvas, resources);
		for (const [index, item] of plan.clips.entries()) {
			const commands = program.files[index]?.contents ?? "";
			for (const frame of [20, 24, 29]) {
				const layer = evaluateCompositionFrame(plan, frame, canvas).layers.find(
					(value) => value.clipId === item.clip.id,
				);
				expect(commands).toContain(
					`colorchannelmixer@alpha${index} aa ${layer?.opacity}`,
				);
			}
			expect(program.graph).toContain(
				`[backdrop${index}][foreground${index}]overlay=x=0:y=0:format=auto:shortest=1,colorchannelmixer@alpha${index}=aa=`,
			);
		}
		expect(program.graph).toContain(
			"[clip0][clip1]blend=all_mode=addition:shortest=1",
		);
		expect(program.graph).toContain("unpremultiply=inplace=1,format=rgba");
		expect(program.graph).toContain("amix=inputs=2:normalize=0");
	});

	it("keeps an AUTO crop-only clip on the old graph path", () => {
		const { document, sources } = autoFixture(),
			first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		first.framing = [
			{
				fromFrame: 0,
				toFrame: 30,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0, y: 0, w: 0.31640625, h: 1 },
			},
		];
		const auto = buildCompositionRenderProgram(
			compileComposition(document, sources),
			canvas,
			resources,
		);
		delete document.presentation;
		const legacy = buildCompositionRenderProgram(
			compileComposition(document, sources),
			canvas,
			resources,
		);
		expect(auto).toEqual(legacy);
		expect(auto.graph).not.toContain("backdrop");
	});
});

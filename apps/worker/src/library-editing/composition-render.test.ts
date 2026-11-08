import {
	compileComposition,
	compositionCaptionRows,
	compositionRenderCanvas,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildCompositionRenderProgram,
	compositionAudioExpression,
	compositionFilterScriptOption,
	escapeCompositionAssText,
} from "./composition-render";

const media = "11111111-1111-4111-8111-111111111111",
	map = "22222222-2222-4222-8222-222222222222",
	clip = "33333333-3333-4333-8333-333333333333",
	item = "44444444-4444-4444-8444-444444444444";
export function renderFixture() {
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
				framing: [
					{
						fromFrame: 0,
						toFrame: 30,
						mode: "CROP",
						origin: "MANUAL",
						rect: { x: 0, y: 0, w: 0.31640625, h: 1 },
					},
				],
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
describe("composition encoder program", () => {
	it("positions each shared caption row at the Canvas line top, including blank CRLF rows", () => {
		const { document, sources } = renderFixture();
		const text = "alpha beta gamma\r\n\rsecond";
		document.captionLayout = { x: 0.1, y: 0.1, w: 0.2, h: 0.8 };
		document.captionStyle = { fontSize: 0.01, align: "LEFT" };
		document.captions = [{ id: item, fromFrame: 0, toFrame: 30, text }];
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-shared-row-top",
		);
		const events =
			program.files
				.find((file) => file.name === "captions.ass")
				?.contents.split("\n")
				.filter((line) => line.startsWith("Dialogue:")) ?? [];
		expect(events).toHaveLength(3);
		for (const [index, y] of [192, 213.85, 257.55].entries()) {
			expect(events[index]).toContain(`\\pos(108,${y})`);
			expect(events[index]).toContain("\\q2");
			expect(events[index]).toContain("\\clip(108,192,324,1728)");
		}
		expect(
			events.map((event) =>
				event
					.split(",")
					.slice(9)
					.join(",")
					.replace(/\{[^}]*\}/g, ""),
			),
		).toEqual(["alpha beta", "gamma", "second"]);
	});
	it("writes balanced Japanese orphan rows and keeps the moved word's exact source emphasis", () => {
		const { document, sources } = renderFixture();
		const text = "あれ俺のお守りあらへんで";
		document.captionLayout = { x: 0.05, y: 0.8, w: 0.9, h: 0.17 };
		document.captionStyle = { fontSize: 0.045 };
		document.captions = [
			{
				id: item,
				fromFrame: 0,
				toFrame: 30,
				text,
				words: [
					{
						text: "あらへんで",
						startChar: 7,
						endChar: 12,
						fromFrame: 0,
						toFrame: 30,
					},
				],
			},
		];
		const before = structuredClone(document);
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-ja-orphan",
		);
		const events =
			program.files
				.find((file) => file.name === "captions.ass")
				?.contents.split("\n")
				.filter((line) => line.startsWith("Dialogue:")) ?? [];
		expect(
			events.map((event) =>
				event
					.split(",")
					.slice(9)
					.join(",")
					.replace(/\{[^}]*\}/g, ""),
			),
		).toEqual(["あれ俺のお守り", "あらへんで"]);
		expect(events[1]).toContain("{\\1c&H4BE0FF&\\1a&H00&}あらへんで");
		expect(events.every((event) => event.includes("\\q2"))).toBe(true);
		expect(document).toEqual(before);
	});
	it("writes explicit Japanese caption rows with complete text and no optional FFmpeg wrap flag", () => {
		const { document, sources } = renderFixture();
		const text =
			"トム、シリア、我々は情熱に従わなきゃ。お前はロボティクス、私は宇宙で最高になりたいんだ";
		document.captionLayout = { x: 0.05, y: 0.8, w: 0.9, h: 0.17 };
		document.captionStyle = { fontSize: 0.045 };
		document.captions = [{ id: item, fromFrame: 0, toFrame: 30, text }];
		const original = structuredClone(document);
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			document.canvas,
			"/tmp/unit-explicit-ja-rows",
		);
		const events =
			program.files
				.find((file) => file.name === "captions.ass")
				?.contents.split("\n")
				.filter((line) => line.startsWith("Dialogue:")) ?? [];
		const payload = events.map((event) =>
			event
				.split(",")
				.slice(9)
				.join(",")
				.replace(/\{[^}]*\}/g, ""),
		);
		expect(payload.length).toBeGreaterThan(1);
		expect(payload.join("")).toBe(text);
		expect(program.graph).not.toContain("wrap_unicode");
		expect(
			compositionFilterScriptOption("ffmpeg version 5.1.7-0+deb12u1"),
		).toBe("-filter_complex_script");
		expect(document).toEqual(original);
	});
	it("keeps UTF16 word emphasis intersections when an English word crosses multiple rows", () => {
		const { document, sources } = renderFixture();
		const word = "Antidisestablishmentarianism".repeat(3),
			text = `Prefix ${word} suffix`;
		document.captionLayout = { x: 0.05, y: 0.1, w: 0.3, h: 0.8 };
		document.captions = [
			{
				id: item,
				fromFrame: 0,
				toFrame: 30,
				text,
				words: [
					{
						text: word,
						startChar: 7,
						endChar: 7 + word.length,
						fromFrame: 0,
						toFrame: 30,
					},
				],
			},
		];
		const original = structuredClone(document);
		const ass =
			buildCompositionRenderProgram(
				compileComposition(document, sources),
				document.canvas,
				"/tmp/unit-explicit-word-rows",
			).files.find((file) => file.name === "captions.ass")?.contents ?? "";
		const payload = ass
			.split("\n")
			.filter((line) => line.startsWith("Dialogue:"))
			.map((line) => line.split(",").slice(9).join(","))
			.join("");
		const highlighted = [
			...payload.matchAll(/\{\\1c&H[^}]+\}([^{}]*)\{\\1c&H[^}]+\}/g),
		].map((m) => m[1]);
		expect(highlighted.length).toBeGreaterThan(1);
		expect(highlighted.join("")).toBe(word);
		expect(
			payload
				.replace(/\{[^}]*\}/g, "")
				.split("\\N")
				.join("")
				.replace(/\s/g, ""),
		).toBe(text.replace(/\s/g, ""));
		expect(document).toEqual(original);
	});
	it("preserves emoji and explicit CRLF/CR/empty caption rows while escaping user literal ASS breaks", () => {
		const { document, sources } = renderFixture();
		const text = "日本😀👩‍👩‍👧‍👦\r\n\r\nAB\rC \\N";
		document.captionLayout = { x: 0.05, y: 0.1, w: 0.9, h: 0.8 };
		document.captions = [{ id: item, fromFrame: 0, toFrame: 30, text }];
		const original = structuredClone(document);
		const ass =
			buildCompositionRenderProgram(
				compileComposition(document, sources),
				document.canvas,
				"/tmp/unit-explicit-emoji-rows",
			).files.find((file) => file.name === "captions.ass")?.contents ?? "";
		const payload = ass
			.split("\n")
			.filter((line) => line.startsWith("Dialogue:"))
			.map((line) =>
				line
					.split(",")
					.slice(9)
					.join(",")
					.replace(/\{[^}]*\}/g, ""),
			);
		expect(payload).toEqual(["日本😀👩‍👩‍👧‍👦", "AB", "C \\\u2060N"]);
		expect(document).toEqual(original);
	});
	it("binds every caption event to its own fitted frame font without changing generic text overlays", () => {
		const { document, sources } = renderFixture(),
			canvas = { width: 360, height: 640 };
		document.captionLayout = { x: 0.05, y: 0.8, w: 0.9, h: 0.17 };
		document.captionStyle = { fontSize: 0.045 };
		document.captions = [
			{
				id: item,
				fromFrame: 0,
				toFrame: 15,
				text: "トム、シリア、我々は情熱に従わなきゃ。お前はロボティクス、私は宇宙で最高になりたいんだ",
			},
			{
				id: "55555555-5555-4555-8555-555555555555",
				fromFrame: 15,
				toFrame: 30,
				text: "Hi",
				words: [
					{ text: "Hi", startChar: 0, endChar: 2, fromFrame: 15, toFrame: 20 },
				],
			},
		];
		document.overlays = [
			{
				id: "66666666-6666-4666-8666-666666666666",
				kind: "TEXT",
				fromFrame: 0,
				toFrame: 30,
				text: "Overlay keeps its user size",
				rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
				opacity: 1,
				zIndex: 1,
				style: { fontSize: 0.07 },
			},
		];
		const plan = compileComposition(document, sources),
			first = evaluateCompositionFrame(plan, 0, canvas).captions[0],
			second = evaluateCompositionFrame(plan, 15, canvas).captions[0];
		if (!first || !second) throw Error("caption fixture");
		const firstPx = Math.round(first.style.fontSize * canvas.height),
			secondPx = Math.round(second.style.fontSize * canvas.height);
		expect(firstPx).toBeLessThan(secondPx);
		const program = buildCompositionRenderProgram(
			plan,
			canvas,
			"/tmp/unit-caption-fit",
		);
		const ass =
				program.files.find((f) => f.name === "captions.ass")?.contents ?? "",
			events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
		const firstRows = compositionCaptionRows({
			text: first.text,
			width: first.rect.w,
			fontSizePx: firstPx,
		}).filter((row) => row.text).length;
		expect(events).toHaveLength(firstRows + 2);
		expect(
			events
				.slice(0, firstRows)
				.every((event) =>
					event.includes(
						`\\fs${firstPx}\\bord${Math.max(1, Math.round(firstPx * 0.08))}`,
					),
				),
		).toBe(true);
		expect(
			events
				.slice(firstRows)
				.every((line) =>
					line.includes(
						`\\fs${secondPx}\\bord${Math.max(1, Math.round(secondPx * 0.08))}`,
					),
				),
		).toBe(true);
		expect(
			program.files.find((f) => f.name === "overlay-0.ass")?.contents,
		).not.toContain("\\fs");
		expect(document.captionStyle.fontSize).toBe(0.045);
	});
	it("exports Japanese subtitle text using cue timing without English word emphasis offsets", () => {
		const { document, sources } = renderFixture();
		document.captionDisplayLanguage = "ja";
		document.captions = [
			{
				id: item,
				fromFrame: 0,
				toFrame: 30,
				text: "Hello",
				words: [
					{
						text: "Hello",
						startChar: 0,
						endChar: 5,
						fromFrame: 0,
						toFrame: 15,
					},
				],
				translation: {
					targetLanguage: "ja",
					text: "こんにちは",
					sourceText: "Hello",
					sourceTextHash: "a".repeat(64),
					origin: "LOCAL_LLM",
					evidenceHash: "b".repeat(64),
				},
			},
		];
		const ass = buildCompositionRenderProgram(
			compileComposition(document, sources),
			{ width: 360, height: 640 },
			"/tmp/unit-caption-ja",
		).files.find((f) => f.name === "captions.ass")?.contents;
		expect(ass).toContain("こんにちは");
		expect(ass).not.toContain("Hello");
		expect(ass?.split("Dialogue:").length).toBe(2);
	});
	it("supports official release and n-prefixed FFmpeg builds without removed options", () => {
		expect(
			compositionFilterScriptOption("ffmpeg version n8.1.3-24-g92611900bb"),
		).toBe("-/filter_complex");
		expect(
			compositionFilterScriptOption("ffmpeg version 9.0.2 Copyright"),
		).toBe("-/filter_complex");
		expect(
			compositionFilterScriptOption("ffmpeg version 5.1.7-0+deb12u1"),
		).toBe("-filter_complex_script");
		expect(() =>
			compositionFilterScriptOption("ffmpeg version unknown"),
		).toThrow("UNSUPPORTED_FFMPEG");
	});
	it("derives per-frame pixel commands from the shared crop evaluator", () => {
		const { document, sources } = renderFixture();
		const first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		first.cropKeyframes = [
			{ frame: 0, rect: { x: 0, y: 0, w: 0.31640625, h: 1 }, easing: "LINEAR" },
			{
				frame: 29,
				rect: { x: 0.68359375, y: 0, w: 0.31640625, h: 1 },
				easing: "LINEAR",
			},
		];
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			{ width: 360, height: 640 },
			"/tmp/bitovp-composition-unit",
		);
		expect(
			program.files.find((f) => f.name === "clip-0.cmd")?.contents,
		).toContain("crop@crop0 w 608");
		expect(
			program.files.find((f) => f.name === "clip-0.cmd")?.contents,
		).toContain("crop@crop0 x 1313");
		expect(program.graph).toContain("premultiply=inplace=1");
		expect(program.graph).toContain("unpremultiply=inplace=1");
		expect(program.graph).toContain("[video]");
		expect(program.graph).toContain("[audio]");
	});
	it("uses real word intervals and escapes text instead of interpreting user markup", () => {
		const { document, sources } = renderFixture();
		document.captions = [
			{
				id: item,
				fromFrame: 0,
				toFrame: 30,
				text: "猫{\\pos(0,0)}犬",
				words: [
					{ text: "猫", startChar: 0, endChar: 1, fromFrame: 1, toFrame: 3 },
				],
			},
		];
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			compositionRenderCanvas(document.canvas, "PREVIEW"),
			"/tmp/bitovp-composition-unit",
		);
		const ass =
			program.files.find((f) => f.name === "captions.ass")?.contents ?? "";
		expect(program.graph).not.toContain("wrap_unicode");
		expect(ass).toContain("0:00:00.03,0:00:00.10");
		// Row events may split a literal user command. Concatenate only the data
		// after each generated position tag in the first measured word interval.
		const data = ass
			.split("\n")
			.filter((line) => line.startsWith("Dialogue: 0,0:00:00.00,0:00:00.03,"))
			.map((line) =>
				line
					.split(",")
					.slice(9)
					.join(",")
					.replace(/^\{[^}]*\}/, ""),
			)
			.join("");
		expect(data).toContain("\\{\\\u2060pos(0,0)\\}");
		expect(ass).not.toContain("{\\pos(0,0)}");
		expect(ass).toContain("Noto Sans CJK JP");
		expect(escapeCompositionAssText("{\\N}\\h\n")).toBe(
			"\\{\\\u2060N\\}\\\u2060h\\N",
		);
	});
	it("mixes same-track transitions before compositing separate tracks", () => {
		const { document, sources } = renderFixture();
		const first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		document.clips.push({
			...structuredClone(first),
			id: item,
			timelineStartFrame: 20,
			transitionIn: { type: "CROSSFADE", durationFrames: 10 },
		});
		const program = buildCompositionRenderProgram(
			compileComposition(document, sources),
			{ width: 360, height: 640 },
			"/tmp/bitovp-composition-unit",
		);
		expect(program.graph).toContain("blend=all_mode=addition");
		expect(program.graph).toContain("aeval=");
		expect(program.graph).toContain("amix=inputs=2:normalize=0");
	});
	it("keeps per-word emphasis alpha and resets to the caption's own alpha", () => {
		const { document, sources } = renderFixture();
		document.captionStyle = { color: "#FFFFFF80", emphasisColor: "#FFE04B00" };
		document.captions = [
			{
				id: item,
				fromFrame: 0,
				toFrame: 30,
				text: "cat",
				words: [
					{ text: "cat", startChar: 0, endChar: 3, fromFrame: 1, toFrame: 3 },
				],
			},
		];
		const ass =
			buildCompositionRenderProgram(
				compileComposition(document, sources),
				{ width: 360, height: 640 },
				"/tmp/bitovp-composition-unit",
			).files.find((file) => file.name === "captions.ass")?.contents ?? "";
		expect(ass).toContain("\\1a&HFF&");
		expect(ass).toContain("\\1a&H7F&");
	});
	it("does not accept stale compiler plans or an altered render aspect", () => {
		const { document, sources } = renderFixture();
		const plan = compileComposition(document, sources);
		const stale = structuredClone(plan);
		Reflect.set(stale, "compilerVersion", "stale");
		expect(() =>
			buildCompositionRenderProgram(
				stale,
				{ width: 360, height: 640 },
				"/tmp/x",
			),
		).toThrow();
		expect(() =>
			buildCompositionRenderProgram(
				plan,
				{ width: 640, height: 640 },
				"/tmp/x",
			),
		).toThrow();
	});
	it("generates sample-time fades, transition and ducking expressions without document expressions", () => {
		const expression = compositionAudioExpression({
			timelineStartFrame: 10,
			durationFrames: 90,
			gainDb: -6,
			fadeInFrames: 30,
			fadeOutFrames: 30,
			ducking: {
				gainDb: -12,
				attackFrames: 3,
				releaseFrames: 5,
				intervals: [{ fromFrame: 40, toFrame: 50 }],
			},
		});
		expect(expression).toContain("t*30");
		expect(expression).toContain("0.5011872336272722");
		expect(expression).toContain("0.251188643150958");
		expect(expression.length).toBeLessThan(1000);
	});
});

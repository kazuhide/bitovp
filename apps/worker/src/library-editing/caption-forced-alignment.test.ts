import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPTION_ALIGNMENT_POLICY,
	hashEditingEvidence,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../../native/caption-alignment-model.json" with {
	type: "json",
};

const execute = vi.hoisted(() => vi.fn());
vi.mock("./process", async (original) => ({
	...(await original<typeof import("./process")>()),
	runMediaProcess: execute,
}));

import { alignSelectedCaptionSegments } from "./caption-forced-alignment";
import { MediaOperationError } from "./process";

const scratch: string[] = [];
afterEach(async () => {
	vi.resetAllMocks();
	vi.restoreAllMocks();
	await Promise.all(
		scratch.splice(0).map((p) => rm(p, { recursive: true, force: true })),
	);
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "alignment-unit-"));
	scratch.push(directory);
	const sourcePath = join(directory, "source.mp4");
	await writeFile(sourcePath, "synthetic-source");
	const input = {
		sourcePath,
		mediaSha256: createHash("sha256").update("synthetic-source").digest("hex"),
		sourceOriginUs: 100_000_000,
		sourceDurationUs: 30_000_000,
		segments: [
			{ startUs: 104_000_000, endUs: 116_000_000, text: "前。次。" },
		] as const,
		selectedRanges: [{ startUs: 109_000_000, endUs: 111_000_000 }],
		language: "ja" as const,
		signal: new AbortController().signal,
	};
	execute.mockImplementation(async (binary, args) => {
		if (binary === "ffmpeg") {
			const duration = Number(args[args.indexOf("-t") + 1]);
			const wav = Buffer.alloc(44 + Math.round(duration * 16000) * 2);
			wav.write("RIFF");
			wav.writeUInt32LE(wav.length - 8, 4);
			wav.write("WAVEfmt ", 8);
			wav.writeUInt32LE(16, 16);
			wav.writeUInt16LE(1, 20);
			wav.writeUInt16LE(1, 22);
			wav.writeUInt32LE(16000, 24);
			wav.writeUInt32LE(32000, 28);
			wav.writeUInt16LE(2, 32);
			wav.writeUInt16LE(16, 34);
			wav.write("data", 36);
			wav.writeUInt32LE(wav.length - 44, 40);
			await writeFile(args.at(-1), wav);
			return { stdout: "", stderr: "" };
		}
		const request = JSON.parse(await readFile(args.at(-1), "utf8"));
		return {
			stdout: JSON.stringify({
				version: "caption-alignment-output-v1",
				engineVersion: "0.0.6",
				modelManifestHash: hashEditingEvidence(manifest),
				modelLoadMs: 10,
				alignmentMs: 20,
				windows: request.windows.map(() => ({
					items: [
						{ text: "前", startUs: 3_000_000, endUs: 4_000_000 },
						{ text: "次", startUs: 9_000_000, endUs: 10_000_000 },
					],
				})),
			}),
			stderr: "",
		};
	});
	return input;
}
it("binds the CPU BF16 runtime script and unchanged model weights to the current policy", async () => {
	expect(manifest.runtime.dtype).toBe("bfloat16");
	expect(manifest.runtime.device).toBe("cpu");
	expect(hashEditingEvidence(manifest)).toBe(
		CAPTION_ALIGNMENT_POLICY.modelManifestHash,
	);
	const script = await readFile(
		new URL("../../scripts/caption-forced-align.py", import.meta.url),
	);
	expect(createHash("sha256").update(script).digest("hex")).toBe(
		manifest.runtime.scriptSha256,
	);
	expect(manifest.files).toHaveLength(8);
	expect(
		manifest.files.find((file) => file.name === "model.safetensors"),
	).toEqual({
		name: "model.safetensors",
		size: 1835544544,
		sha256: "47831d0e82f96b20e9034dba01a075ee06436654719f6a68289e49f1b65ce0e7",
	});
});
it("includes the entire ASR paragraph audio and maps estimated words once to original UTF16 offsets", async () => {
	const input = await fixture();
	const before = structuredClone(input.segments);
	const result = await alignSelectedCaptionSegments(input);
	expect(result.segments[0]).toEqual({
		startUs: 104_000_000,
		endUs: 111_000_000,
		text: "前。次。",
		words: [
			{
				text: "前",
				startChar: 0,
				endChar: 1,
				startUs: 104_000_000,
				endUs: 105_000_000,
				confidence: 0,
			},
			{
				text: "次",
				startChar: 2,
				endChar: 3,
				startUs: 110_000_000,
				endUs: 111_000_000,
				confidence: 0,
			},
		],
	});
	expect(input.segments).toEqual(before);
	expect(result.receipt).toMatchObject({
		version: "qwen3-caption-alignment-v7",
		confidence: "NOT_REPORTED",
		sourceAudioUs: 18_000_000,
		inputHash: hashEditingEvidence({
			policy: CAPTION_ALIGNMENT_POLICY,
			mediaSha256: input.mediaSha256,
			sourceOriginUs: input.sourceOriginUs,
			sourceDurationUs: input.sourceDurationUs,
			segments: input.segments,
			selectedRanges: input.selectedRanges,
			language: input.language,
		}),
		outputHash: hashEditingEvidence(result.segments),
	});
	expect(execute.mock.calls[0]?.[1]).toContain("file,pipe");
	expect(execute.mock.calls[0]?.[1]).toContain("1.000000");
});
it("writes paragraph-owned v2 native requests without changing original transcript text", async () => {
	const input = await fixture();
	const original = execute.getMockImplementation();
	const requests: {
		version: string;
		windows: { text: string; paragraphTexts: string[] }[];
	}[] = [];
	execute.mockImplementation(async (...args) => {
		if (args[0] !== "ffmpeg")
			requests.push(JSON.parse(await readFile(args[1].at(-1), "utf8")));
		return original?.(...args);
	});
	await alignSelectedCaptionSegments({
		...input,
		segments: [
			{ startUs: 104_000_000, endUs: 106_000_000, text: "前。" },
			{ startUs: 110_000_000, endUs: 112_000_000, text: "次。" },
		],
		selectedRanges: [
			{ startUs: 105_000_000, endUs: 105_500_000 },
			{ startUs: 111_000_000, endUs: 111_500_000 },
		],
	});
	expect(requests[0]?.version).toBe("caption-alignment-request-v2");
	expect(
		requests[0]?.windows.map(({ text, paragraphTexts }) => ({
			text,
			paragraphTexts,
		})),
	).toEqual([{ text: "前。 次。", paragraphTexts: ["前。", "次。"] }]);
});
it("preserves finite native memory unavailability for safe caption omission", async () => {
	const input = await fixture();
	const original = execute.getMockImplementation();
	execute.mockImplementation(async (...args) =>
		args[0] === "ffmpeg"
			? original?.(...args)
			: {
					stdout: JSON.stringify({ error: "CAPTION_ALIGNMENT_UNAVAILABLE" }),
					stderr: "",
				},
	);
	await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
		code: "CAPTION_ALIGNMENT_UNAVAILABLE",
		message: "CAPTION_ALIGNMENT_UNAVAILABLE",
	});
});
describe("alignment output diagnostics", () => {
	it.each([
		[
			"native",
			"NATIVE_ITEM_ZERO_DURATION",
			{
				error: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
				reason: "NATIVE_ITEM_ZERO_DURATION",
				windowIndex: 0,
				itemIndex: 2,
			},
		],
		[
			"legacy",
			"NATIVE_OUTPUT_INVALID",
			{ error: "CAPTION_ALIGNMENT_OUTPUT_INVALID" },
		],
		[
			"decoder finite",
			"NATIVE_DECODER_NONFINITE",
			{
				error: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
				reason: "NATIVE_DECODER_NONFINITE",
			},
		],
		[
			"private reason",
			"NODE_ERROR_ENVELOPE",
			{
				error: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
				reason: "synthetic-private /source token=secret",
			},
		],
		[
			"unbounded index",
			"NODE_ERROR_ENVELOPE",
			{
				error: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
				reason: "NATIVE_ITEM_ZERO_DURATION",
				windowIndex: 80,
				itemIndex: 30000,
			},
		],
		[
			"extra raw field",
			"NODE_ERROR_ENVELOPE",
			{
				error: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
				reason: "NATIVE_ITEM_ZERO_DURATION",
				raw: "synthetic-private",
			},
		],
		["json", "NODE_JSON_DECODE", "synthetic-private not-json"],
		["contract", "NODE_OUTPUT_CONTRACT", { version: "synthetic-private" }],
	] as const)("keeps %s failure strict and logs only a finite reason", async (change, reason, payload) => {
		const input = await fixture();
		const original = execute.getMockImplementation();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		execute.mockImplementation(async (...args) =>
			args[0] === "ffmpeg"
				? original?.(...args)
				: {
						stdout:
							typeof payload === "string" ? payload : JSON.stringify(payload),
						stderr: "synthetic-private stderr /source token=secret",
					},
		);
		await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
			code: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
		});
		expect(warning.mock.calls).toEqual([
			[
				JSON.stringify({
					event: "caption_alignment_output_rejected",
					errorCode: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
					reason,
					...(change === "native" ? { windowIndex: 0, itemIndex: 2 } : {}),
				}),
			],
		]);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(
			"synthetic-private",
		);
	});

	it("keeps legacy unknown errors unchanged and isolates a failing diagnostic sink", async () => {
		const input = await fixture();
		const original = execute.getMockImplementation();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error("synthetic-private sink");
		});
		let payload = { error: "synthetic-private" };
		execute.mockImplementation(async (...args) =>
			args[0] === "ffmpeg"
				? original?.(...args)
				: { stdout: JSON.stringify(payload), stderr: "" },
		);
		await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
			code: "CAPTION_ALIGNMENT_RUNTIME_FAILED",
		});
		expect(warning).not.toHaveBeenCalled();
		payload = { error: "CAPTION_ALIGNMENT_OUTPUT_INVALID" };
		await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
			code: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
		});
		expect(warning).toHaveBeenCalledTimes(1);
	});
});
describe("zero duration endpoint grouping", () => {
	async function zeroFixture(
		text: string,
		items: { text: string; startUs: number; endUs: number }[],
	) {
		const base = await fixture();
		const input = {
			...base,
			segments: [{ ...base.segments[0], text }],
			selectedRanges: [{ startUs: 104_000_000, endUs: 116_000_000 }],
		};
		const original = execute.getMockImplementation();
		execute.mockImplementation(async (...args) => {
			const value = await original?.(...args);
			if (args[0] === "ffmpeg") return value;
			const out = JSON.parse(value.stdout);
			for (const window of out.windows) window.items = items;
			return { stdout: JSON.stringify(out), stderr: "" };
		});
		return input;
	}
	const item = (text: string, startUs: number, endUs: number) => ({
		text,
		startUs,
		endUs,
	});
	const word = (
		text: string,
		startChar: number,
		endChar: number,
		startUs: number,
		endUs: number,
	) => ({ text, startChar, endChar, startUs, endUs, confidence: 0 });
	it.each([
		{
			name: "leading",
			text: "前次",
			items: [
				item("前", 3_000_000, 3_000_000),
				item("次", 3_000_000, 4_000_000),
			],
			expected: [word("前次", 0, 2, 104_000_000, 105_000_000)],
		},
		{
			name: "trailing",
			text: "前次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("次", 4_000_000, 4_000_000),
			],
			expected: [word("前次", 0, 2, 104_000_000, 105_000_000)],
		},
		{
			name: "middle left preferred",
			text: "前中次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("中", 4_000_000, 4_000_000),
				item("次", 4_000_000, 5_000_000),
			],
			expected: [
				word("前中", 0, 2, 104_000_000, 105_000_000),
				word("次", 2, 3, 105_000_000, 106_000_000),
			],
		},
		{
			name: "same point run",
			text: "前には次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("に", 4_000_000, 4_000_000),
				item("は", 4_000_000, 4_000_000),
				item("次", 4_000_000, 5_000_000),
			],
			expected: [
				word("前には", 0, 3, 104_000_000, 105_000_000),
				word("次", 3, 4, 105_000_000, 106_000_000),
			],
		},
		{
			name: "right anchor across no invented interval",
			text: "前中次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("中", 5_000_000, 5_000_000),
				item("次", 5_000_000, 6_000_000),
			],
			expected: [
				word("前", 0, 1, 104_000_000, 105_000_000),
				word("中次", 1, 3, 106_000_000, 107_000_000),
			],
		},
		{
			name: "UTF16 and punctuation",
			text: "😀前、次。",
			items: [
				item("前", 3_000_000, 3_000_000),
				item("次", 3_000_000, 4_000_000),
			],
			expected: [word("前、次", 2, 5, 104_000_000, 105_000_000)],
		},
	])("groups $name only at an existing positive endpoint", async ({
		text,
		items,
		expected,
	}) => {
		const input = await zeroFixture(text, items);
		const before = structuredClone(input.segments);
		const result = await alignSelectedCaptionSegments(input);
		expect(result.segments[0]?.words).toEqual(expected);
		expect(result.segments[0]?.text).toBe(text);
		expect(input.segments).toEqual(before);
		expect(result.receipt.confidence).toBe("NOT_REPORTED");
		expect(
			result.segments
				.flatMap((segment) => segment.words ?? [])
				.every((entry) => entry.endUs > entry.startUs),
		).toBe(true);
	});
	it.each([
		{
			name: "all zero",
			text: "前次",
			items: [
				item("前", 3_000_000, 3_000_000),
				item("次", 3_000_000, 3_000_000),
			],
		},
		{
			name: "leading gap",
			text: "前次",
			items: [
				item("前", 3_000_000, 3_000_000),
				item("次", 4_000_000, 5_000_000),
			],
		},
		{
			name: "trailing gap",
			text: "前次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("次", 5_000_000, 5_000_000),
			],
		},
		{
			name: "middle gap",
			text: "前中次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("中", 5_000_000, 5_000_000),
				item("次", 6_000_000, 7_000_000),
			],
		},
		{
			name: "nonmonotonic",
			text: "前次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("次", 3_500_000, 3_500_000),
			],
		},
		{
			name: "negative",
			text: "前次",
			items: [item("前", -1, -1), item("次", 3_000_000, 4_000_000)],
		},
		{
			name: "reversed",
			text: "前次",
			items: [
				item("前", 3_000_000, 2_000_000),
				item("次", 4_000_000, 5_000_000),
			],
		},
		{
			name: "out of window",
			text: "前次",
			items: [
				item("前", 3_000_000, 4_000_000),
				item("次", 30_000_000, 30_000_000),
			],
		},
	])("rejects $name instead of guessing timing", async ({ text, items }) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const input = await zeroFixture(text, items);
		await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
			code: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
		});
	});
	it.each([
		"borrow previous paragraph",
		"native item crosses paragraphs",
	])("rejects %s before inventing a group", async (change) => {
		const items =
			change === "borrow previous paragraph"
				? [
						item("前", 3_000_000, 4_000_000),
						item("中", 4_000_000, 4_000_000),
						item("次", 6_000_000, 7_000_000),
					]
				: [item("前中次", 3_000_000, 4_000_000)];
		const base = await zeroFixture("unused", items);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			alignSelectedCaptionSegments({
				...base,
				segments: [
					{ startUs: 104_000_000, endUs: 106_000_000, text: "前" },
					{ startUs: 110_000_000, endUs: 112_000_000, text: "中次" },
				],
				selectedRanges: [
					{ startUs: 105_000_000, endUs: 105_500_000 },
					{ startUs: 111_000_000, endUs: 111_500_000 },
				],
			}),
		).rejects.toMatchObject({
			code:
				change === "borrow previous paragraph"
					? "CAPTION_ALIGNMENT_OUTPUT_INVALID"
					: "CAPTION_ALIGNMENT_TEXT_MISMATCH",
		});
	});
	describe("selected zero point scope", () => {
		it("handles a synthetic 20ms coarse overlap without claiming unused zero-token timing", async () => {
			const base = await zeroFixture("unused", [
				item("前", 3_520_000, 3_520_000),
				item("次", 3_760_000, 4_000_000),
			]);
			const input = {
				...base,
				sourceOriginUs: 500_000_000,
				sourceDurationUs: 20_000_000,
				segments: [{ startUs: 506_180_000, endUs: 507_220_000, text: "前次" }],
				selectedRanges: [{ startUs: 507_200_000, endUs: 516_000_000 }],
			};
			const before = structuredClone(input.segments);
			const result = await alignSelectedCaptionSegments(input);
			expect(result.segments[0]?.words).toEqual([
				word("次", 1, 2, 506_940_000, 507_180_000),
			]);
			expect(input.segments).toEqual(before);
		});
		it.each([
			{
				name: "outside prefix",
				text: "前次",
				items: [
					item("前", 3_000_000, 3_000_000),
					item("次", 9_000_000, 10_000_000),
				],
				ranges: [{ startUs: 109_000_000, endUs: 111_000_000 }],
				expected: [word("次", 1, 2, 110_000_000, 111_000_000)],
			},
			{
				name: "zero exactly at excluded end",
				text: "前次",
				items: [
					item("前", 3_000_000, 4_000_000),
					item("次", 4_000_000, 4_000_000),
				],
				ranges: [{ startUs: 104_000_000, endUs: 105_000_000 }],
				expected: [word("前", 0, 1, 104_000_000, 105_000_000)],
			},
			{
				name: "positives across clips",
				text: "前中次",
				items: [
					item("前", 3_000_000, 4_000_000),
					item("中", 5_000_000, 5_000_000),
					item("次", 9_000_000, 10_000_000),
				],
				ranges: [
					{ startUs: 104_000_000, endUs: 105_000_000 },
					{ startUs: 110_000_000, endUs: 111_000_000 },
				],
				expected: [
					word("前", 0, 1, 104_000_000, 105_000_000),
					word("次", 2, 3, 110_000_000, 111_000_000),
				],
			},
			{
				name: "all outside empty",
				text: "前次",
				items: [
					item("前", 3_000_000, 3_000_000),
					item("次", 4_000_000, 4_000_000),
				],
				ranges: [{ startUs: 109_000_000, endUs: 111_000_000 }],
				expected: [],
			},
		])("omits only $name zeros and leaves positive endpoints unchanged", async ({
			text,
			items,
			ranges,
			expected,
		}) => {
			const base = await zeroFixture(text, items);
			const input = { ...base, selectedRanges: ranges };
			const before = structuredClone(input.segments);
			const result = await alignSelectedCaptionSegments(input);
			expect(result.segments.flatMap((segment) => segment.words ?? [])).toEqual(
				expected,
			);
			if (!expected.length) expect(result.segments).toEqual([]);
			expect(result.receipt.outputHash).toBe(
				hashEditingEvidence(result.segments),
			);
			expect(result.receipt.confidence).toBe("NOT_REPORTED");
			expect(input.segments).toEqual(before);
		});
		it("omits an all-outside optional paragraph while retaining positive context words", async () => {
			const base = await zeroFixture("unused", [
				item("前", 1_000_000, 1_000_000),
				item("中", 2_000_000, 2_000_000),
				item("次", 3_000_000, 4_000_000),
			]);
			const result = await alignSelectedCaptionSegments({
				...base,
				segments: [
					{ startUs: 106_000_000, endUs: 107_000_000, text: "前中" },
					{ startUs: 108_000_000, endUs: 110_000_000, text: "次" },
				],
				selectedRanges: [{ startUs: 109_000_000, endUs: 111_000_000 }],
			});
			expect(result.segments).toEqual([
				{
					startUs: 108_000_000,
					endUs: 109_000_000,
					text: "次",
					words: [word("次", 0, 1, 108_000_000, 109_000_000)],
				},
			]);
		});
		it("keeps a zero exactly at the included start subject to the same strict anchor rule", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const base = await zeroFixture("前次", [
				item("前", 3_000_000, 3_000_000),
				item("次", 4_000_000, 5_000_000),
			]);
			await expect(
				alignSelectedCaptionSegments({
					...base,
					selectedRanges: [{ startUs: 104_000_000, endUs: 104_500_000 }],
				}),
			).rejects.toMatchObject({ code: "CAPTION_ALIGNMENT_OUTPUT_INVALID" });
		});
		it.each([
			"lexical mismatch",
			"raw out of window",
		])("checks outside-zero %s before the scope filter", async (change) => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const base = await zeroFixture(
				"前次",
				change === "lexical mismatch"
					? [
							item("偽", 3_000_000, 3_000_000),
							item("次", 9_000_000, 10_000_000),
						]
					: [
							item("前", 30_000_000, 30_000_000),
							item("次", 31_000_000, 32_000_000),
						],
			);
			await expect(
				alignSelectedCaptionSegments({
					...base,
					selectedRanges: [{ startUs: 109_000_000, endUs: 111_000_000 }],
				}),
			).rejects.toMatchObject({
				code:
					change === "lexical mismatch"
						? "CAPTION_ALIGNMENT_TEXT_MISMATCH"
						: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
			});
		});
	});
	describe("no-anchor numeric diagnostics", () => {
		it.each([
			"gap",
			"required all-zero",
		] as const)("records only bounded %s context without accepting the group", async (kind) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			let input: Parameters<typeof alignSelectedCaptionSegments>[0] = {
				...(await zeroFixture("前中次", [
					item("前", 3_000_000, 4_000_000),
					item("中", 5_000_000, 5_000_000),
					item("次", 6_000_000, 7_000_000),
				])),
				selectedRanges: [{ startUs: 105_000_000, endUs: 106_500_000 }],
			};
			if (kind === "required all-zero") {
				input = {
					...(await zeroFixture("前中", [
						item("前", 3_000_000, 3_000_000),
						item("中", 4_000_000, 4_000_000),
					])),
					selectedRanges: [{ startUs: 104_000_000, endUs: 106_000_000 }],
				};
			}
			await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
				code: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
			});
			const gap = kind === "gap";
			expect(warning.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
				{
					event: "caption_alignment_zero_group_unresolved",
					windowIndex: 0,
					paragraphIndex: 0,
					paragraphSelected: true,
					zeroSelected: true,
					tokenIndex: gap ? 1 : 0,
					runLength: 1,
					tokensInParagraph: gap ? 3 : 2,
					positiveTokenCount: gap ? 2 : 0,
					zeroAtUs: gap ? 5_000_000 : 3_000_000,
					zeroStartChar: gap ? 1 : 0,
					zeroEndChar: gap ? 2 : 1,
					left: gap
						? {
								fromUs: 3_000_000,
								toUs: 4_000_000,
								startChar: 0,
								endChar: 1,
								positive: true,
							}
						: null,
					right: gap
						? {
								fromUs: 6_000_000,
								toUs: 7_000_000,
								startChar: 2,
								endChar: 3,
								positive: true,
							}
						: {
								fromUs: 4_000_000,
								toUs: 4_000_000,
								startChar: 1,
								endChar: 2,
								positive: false,
							},
					leftGapUs: gap ? 1_000_000 : null,
					rightGapUs: 1_000_000,
					leftCharAdjacent: gap ? true : null,
					rightCharAdjacent: true,
				},
				{
					event: "caption_alignment_output_rejected",
					errorCode: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
					reason: "NODE_ZERO_DURATION_NO_ANCHOR",
					windowIndex: 0,
				},
			]);
		});
		it("excludes text and preserves strict rejection if both diagnostic sinks throw", async () => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {
				throw new Error("synthetic-private /never-log/token");
			});
			const input = {
				...(await zeroFixture("secret-text", [
					item("secret", 3_000_000, 4_000_000),
					item("text", 5_000_000, 5_000_000),
				])),
				selectedRanges: [{ startUs: 106_000_000, endUs: 106_500_000 }],
			};
			await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
				code: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
			});
			expect(warning).toHaveBeenCalledTimes(2);
			expect(JSON.parse(warning.mock.calls[0]?.[0]).zeroSelected).toBe(true);
			const logged = JSON.stringify(warning.mock.calls);
			for (const sensitive of [
				"secret",
				"synthetic-private",
				"/never-log",
				input.sourcePath,
			])
				expect(logged).not.toContain(sensitive);
		});
	});
});
it.each([
	"mismatch",
	"zero",
	"overlap",
	"outside",
])("rejects %s timestamps/text without whole-paragraph fallback", async (change) => {
	const input = await fixture();
	const original = execute.getMockImplementation();
	execute.mockImplementation(async (...args) => {
		const value = await original?.(...args);
		if (args[0] === "ffmpeg") return value;
		const out = JSON.parse(value.stdout);
		const items = out.windows[0].items;
		if (change === "mismatch") items[1].text = "別";
		if (change === "zero") items[0].startUs = items[0].endUs = 8_000_000;
		if (change === "overlap") items[1].startUs = items[0].startUs;
		if (change === "outside") items[1].endUs = 90_000_000;
		return { stdout: JSON.stringify(out), stderr: "" };
	});
	await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
		code: expect.stringMatching(/^CAPTION_ALIGNMENT_/),
	});
});
it("refuses unknown language, an overlong full paragraph, or canceled work before model invocation", async () => {
	const input = await fixture();
	await expect(
		alignSelectedCaptionSegments({ ...input, language: "auto" }),
	).rejects.toMatchObject({ code: "CAPTION_ALIGNMENT_LANGUAGE_UNSUPPORTED" });
	await expect(
		alignSelectedCaptionSegments({
			...input,
			sourceDurationUs: 90_000_000,
			segments: [{ ...input.segments[0], endUs: 180_000_000 }],
		}),
	).rejects.toMatchObject({ code: "CAPTION_ALIGNMENT_LIMIT" });
	const controller = new AbortController();
	controller.abort();
	await expect(
		alignSelectedCaptionSegments({ ...input, signal: controller.signal }),
	).rejects.toMatchObject({ code: "CANCELED" });
	expect(execute).not.toHaveBeenCalled();
});
it("does not add the full text of context paragraphs whose audio is only partly inside the window", async () => {
	const input = await fixture();
	const result = await alignSelectedCaptionSegments({
		...input,
		segments: [
			{ startUs: 100_000_000, endUs: 104_000_000, text: "外の前" },
			...input.segments,
			{ startUs: 118_000_000, endUs: 125_000_000, text: "外の次" },
		],
	});
	expect(result.segments.map((s) => s.text)).toEqual(["前。次。"]);
});
it("merges overlapping contexts once and returns each complete paragraph without repetition", async () => {
	const input = await fixture();
	const result = await alignSelectedCaptionSegments({
		...input,
		segments: [
			{ startUs: 104_000_000, endUs: 106_000_000, text: "前。" },
			{ startUs: 110_000_000, endUs: 112_000_000, text: "次。" },
		],
		selectedRanges: [
			{ startUs: 105_000_000, endUs: 105_500_000 },
			{ startUs: 111_000_000, endUs: 111_500_000 },
		],
	});
	expect(result.receipt.windows).toHaveLength(1);
	expect(result.segments.map((s) => s.text)).toEqual(["前。", "次。"]);
	expect(
		execute.mock.calls.filter(([binary]) => binary !== "ffmpeg"),
	).toHaveLength(1);
});
it("preserves original UTF16 positions across ignored emoji and punctuation", async () => {
	const input = await fixture();
	const result = await alignSelectedCaptionSegments({
		...input,
		segments: [{ ...input.segments[0], text: "😀前。次。" }],
	});
	expect(
		result.segments[0]?.words?.map((w) => [w.startChar, w.endChar]),
	).toEqual([
		[2, 3],
		[4, 5],
	]);
	expect(result.segments[0]?.text).toBe("😀前。次。");
});
it("enforces the combined audio limit before extraction or model invocation", async () => {
	const input = await fixture();
	const segments = Array.from({ length: 5 }, (_, i) => ({
		startUs: 110_000_000 + i * 70_000_000,
		endUs: 159_000_000 + i * 70_000_000,
		text: "前",
	}));
	await expect(
		alignSelectedCaptionSegments({
			...input,
			sourceDurationUs: 400_000_000,
			segments,
			selectedRanges: segments.map((s) => ({
				startUs: s.startUs + 1_000_000,
				endUs: s.startUs + 2_000_000,
			})),
		}),
	).rejects.toMatchObject({ code: "CAPTION_ALIGNMENT_LIMIT" });
	expect(execute).not.toHaveBeenCalled();
});
it("preserves cancellation and removes owned PCM/text scratch after native failure", async () => {
	const input = await fixture();
	const original = execute.getMockImplementation();
	let requestPath = "";
	execute.mockImplementation(async (...args) => {
		if (args[0] === "ffmpeg") return original?.(...args);
		requestPath = args[1].at(-1);
		throw new MediaOperationError("CANCELED");
	});
	await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
		code: "CANCELED",
	});
	expect(requestPath).not.toBe("");
	await expect(stat(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(stat(input.sourcePath)).resolves.toMatchObject({ size: 16 });
});
async function oneItemPerWindow() {
	const original = execute.getMockImplementation();
	execute.mockImplementation(async (...args) => {
		if (args[0] === "ffmpeg") return original?.(...args);
		const request = JSON.parse(await readFile(args[1].at(-1), "utf8"));
		return {
			stdout: JSON.stringify({
				version: "caption-alignment-output-v1",
				engineVersion: "0.0.6",
				modelManifestHash: hashEditingEvidence(manifest),
				modelLoadMs: 1,
				alignmentMs: 2,
				windows: request.windows.map((w: { text: string }) => ({
					items: [{ text: w.text, startUs: 3_000_000, endUs: 4_000_000 }],
				})),
			}),
			stderr: "",
		};
	});
}
it("preserves distinct original clocks across noncontiguous selected windows without including the middle paragraph", async () => {
	const input = await fixture();
	await oneItemPerWindow();
	const result = await alignSelectedCaptionSegments({
		...input,
		sourceDurationUs: 90_000_000,
		segments: [
			{ startUs: 104_000_000, endUs: 106_000_000, text: "前" },
			{ startUs: 130_000_000, endUs: 136_000_000, text: "間" },
			{ startUs: 180_000_000, endUs: 182_000_000, text: "次" },
		],
		selectedRanges: [
			{ startUs: 105_000_000, endUs: 105_500_000 },
			{ startUs: 181_000_000, endUs: 181_500_000 },
		],
	});
	expect(result.segments.map((s) => [s.text, s.startUs])).toEqual([
		["前", 104_000_000],
		["次", 180_000_000],
	]);
	expect(result.receipt.sourceAudioUs).toBe(16_000_000);
	expect(result.receipt.windows).toHaveLength(2);
});
it("shrinks optional context at paragraph boundaries when merging would exceed sixty seconds", async () => {
	const input = await fixture();
	await oneItemPerWindow();
	const result = await alignSelectedCaptionSegments({
		...input,
		sourceDurationUs: 100_000_000,
		segments: [
			{ startUs: 104_000_000, endUs: 139_000_000, text: "前" },
			{ startUs: 139_000_000, endUs: 170_000_000, text: "次" },
		],
		selectedRanges: [
			{ startUs: 105_000_000, endUs: 106_000_000 },
			{ startUs: 140_000_000, endUs: 141_000_000 },
		],
	});
	expect(result.receipt.windows.map((w) => [w.startUs, w.endUs])).toEqual([
		[101_000_000, 139_000_000],
		[139_000_000, 173_000_000],
	]);
	expect(result.segments.map((s) => s.text)).toEqual(["前", "次"]);
});

it.each([
	"positive",
	"zero",
	"invalid",
] as const)("handles preplanned interjection focus windows in one native call (%s)", async (mode) => {
	const basic = await fixture();
	const input: Parameters<typeof alignSelectedCaptionSegments>[0] = {
		...basic,
		sourceOriginUs: 0,
		sourceDurationUs: 700_000_000,
		segments: [{ text: "あれ俺", startUs: 507220000, endUs: 514970000 }],
		selectedRanges: [{ startUs: 507200000, endUs: 516866667 }],
		captionTimingEvidence: {
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			mediaSha256: basic.mediaSha256,
			modelSha256:
				"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			transcriptHash: "a".repeat(64),
			rawSegments: [
				{
					text: "あれ俺",
					startUs: 507220000,
					endUs: 514970000,
					tokens: [
						{ text: "あれ", startUs: 507220000, endUs: 512570000, p: 0.59 },
						{ text: "俺", startUs: 513640000, endUs: 514970000, p: 0.9 },
					],
					quality: {
						decision: "ADMITTED",
						noSpeechProbability: 0,
						meanTokenLogProbability: -0.1,
						speechOverlapUs: 2000000,
					},
				},
			],
			speechIntervals: [
				{ startUs: 506670000, endUs: 507330000 },
				{ startUs: 511490000, endUs: 511910000 },
				{ startUs: 512270000, endUs: 512810000 },
				{ startUs: 513640000, endUs: 515300000 },
			],
		},
	};
	const original = execute.getMockImplementation();
	let nativeCalls = 0;
	let planned = 0;
	execute.mockImplementation(async (...args) => {
		if (args[0] === "ffmpeg") return original?.(...args);
		nativeCalls++;
		const request = JSON.parse(await readFile(args[1].at(-1), "utf8"));
		planned = request.windows.length;
		return {
			stdout: JSON.stringify({
				version: "caption-alignment-output-v1",
				engineVersion: "0.0.6",
				modelManifestHash: hashEditingEvidence(manifest),
				modelLoadMs: 10,
				alignmentMs: 20,
				windows: request.windows.map((w: { text: string }) => ({
					items:
						w.text === "あれ俺"
							? [
									{ text: "あれ", startUs: 2960000, endUs: 9520000 },
									{ text: "俺", startUs: 9520000, endUs: 10680000 },
								]
							: [
									{
										text: "あれ",
										startUs: 260000,
										endUs:
											mode === "positive"
												? 570000
												: mode === "zero"
													? 260000
													: 2000000,
									},
								],
				})),
			}),
			stderr: "",
		};
	});
	const before = structuredClone(input.captionTimingEvidence);
	if (mode === "invalid") {
		await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
			code: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
		});
		expect(nativeCalls).toBe(1);
		return;
	}
	const result = await alignSelectedCaptionSegments(input);
	expect(result.segments[0]?.words?.[0]).toMatchObject({
		text: "あれ",
		startChar: 0,
		endChar: 2,
		startUs: mode === "positive" ? 512280000 : 507180000,
		endUs: mode === "positive" ? 512590000 : 513740000,
		confidence: 0,
	});
	expect(nativeCalls).toBe(1);
	expect(planned).toBe(2);
	expect(result.receipt.focusWindows[0]).toMatchObject({
		kind: "TOKEN_END_ISLAND",
		outcome: mode === "positive" ? "ADOPTED" : "ZERO_OR_UNSUPPORTED",
	});
	expect(result.receipt.measurements.base[0]).toMatchObject({
		startUs: 507180000,
	});
	if (mode === "positive")
		expect(result.receipt.baseOutputHash).not.toBe(result.receipt.outputHash);
	else expect(result.receipt.baseOutputHash).toBe(result.receipt.outputHash);
	expect(result.receipt.measurements.final[0]).toMatchObject({
		startUs: mode === "positive" ? 512280000 : 507180000,
	});
	expect(input.captionTimingEvidence).toEqual(before);
});

it.each([
	"improved",
	"still-short",
] as const)("remeasures the supported trailing phrase without accepting a still-short word (%s)", async (mode) => {
	const basic = await fixture();
	const input: Parameters<typeof alignSelectedCaptionSegments>[0] = {
		...basic,
		sourceOriginUs: 0,
		sourceDurationUs: 700000000,
		segments: [
			{ text: "人玉と共に現れ", startUs: 617800000, endUs: 620830000 },
		],
		selectedRanges: [{ startUs: 613266667, endUs: 623200000 }],
		captionTimingEvidence: {
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			mediaSha256: basic.mediaSha256,
			modelSha256:
				"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			transcriptHash: "b".repeat(64),
			rawSegments: [
				{
					text: "人玉と共に現れ",
					startUs: 617800000,
					endUs: 620830000,
					tokens: [
						{ text: "人", startUs: 617800000, endUs: 618980000, p: 0.83 },
						{ text: "玉", startUs: 618980000, endUs: 619600000, p: 0.88 },
						{ text: "と", startUs: 619720000, endUs: 619880000, p: 0.98 },
						{ text: "共", startUs: 619880000, endUs: 620110000, p: 0.92 },
						{ text: "に", startUs: 620110000, endUs: 620340000, p: 0.99 },
						{ text: "現", startUs: 620340000, endUs: 620570000, p: 0.98 },
						{ text: "れ", startUs: 620570000, endUs: 620760000, p: 0.99 },
					],
					quality: {
						decision: "ADMITTED",
						noSpeechProbability: 0,
						meanTokenLogProbability: -0.1,
						speechOverlapUs: 1900000,
					},
				},
			],
			speechIntervals: [
				{ startUs: 614500000, endUs: 617850000 },
				{ startUs: 618980000, endUs: 620990000 },
			],
		},
	};
	const original = execute.getMockImplementation();
	let nativeCalls = 0;
	execute.mockImplementation(async (...args) => {
		if (args[0] === "ffmpeg") return original?.(...args);
		nativeCalls++;
		const request = JSON.parse(await readFile(args[1].at(-1), "utf8"));
		return {
			stdout: JSON.stringify({
				version: "caption-alignment-output-v1",
				engineVersion: "0.0.6",
				modelManifestHash: hashEditingEvidence(manifest),
				modelLoadMs: 10,
				alignmentMs: 20,
				windows: request.windows.map((w: { text: string }) => ({
					items:
						w.text === "人玉と共に現れ"
							? [
									{ text: "人玉と", startUs: 4200000, endUs: 4600000 },
									{ text: "共", startUs: 4600000, endUs: 4700000 },
									{ text: "に", startUs: 4700000, endUs: 5960000 },
									{ text: "現れ", startUs: 5960000, endUs: 6040000 },
								]
							: [
									{
										text: "に",
										startUs: mode === "improved" ? 250000 : 0,
										endUs: mode === "improved" ? 480000 : 320000,
									},
									{
										text: "現れ",
										startUs: 480000,
										endUs: mode === "improved" ? 900000 : 560000,
									},
								],
				})),
			}),
			stderr: "",
		};
	});
	const result = await alignSelectedCaptionSegments(input);
	expect(nativeCalls).toBe(1);
	expect(result.receipt.focusWindows).toHaveLength(1);
	expect(result.receipt.focusWindows[0]).toMatchObject({
		kind: "SUPPORTED_SUFFIX",
		startChar: 4,
		endChar: 7,
		outcome: mode === "improved" ? "ADOPTED" : "RAW_SUPPORTED_GROUP",
	});
	expect(result.segments[0]?.words?.slice(0, 2)).toMatchObject([
		{ text: "人玉と", startUs: 619000000, endUs: 619400000 },
		{ text: "共", startUs: 619400000, endUs: 619500000 },
	]);
	if (mode === "improved")
		expect(result.segments[0]?.words?.slice(2)).toMatchObject([
			{ text: "に", startUs: 620110000, endUs: 620340000 },
			{ text: "現れ", startUs: 620340000, endUs: 620760000 },
		]);
	else {
		expect(result.segments[0]?.words?.slice(2)).toMatchObject([
			{ text: "に現れ", startUs: 620110000, endUs: 620760000 },
		]);
		expect(result.receipt.measurements.final.at(-1)).toMatchObject({
			timingSource: "ASR_TOKEN_GROUP",
			focusId: "f0",
		});
		expect(result.receipt.measurements.final.at(-1)).not.toHaveProperty(
			"windowIndex",
		);
	}
	expect(result.receipt.measurements.focus).toHaveLength(2);
	expect(result.receipt.measurements.final).toHaveLength(
		mode === "improved" ? 4 : 3,
	);
});

it("checks the primary text cap before optional focus metadata and before any media process", async () => {
	const basic = await fixture();
	const input: Parameters<typeof alignSelectedCaptionSegments>[0] = {
		...basic,
		sourceOriginUs: 0,
		sourceDurationUs: 700000000,
		segments: Array.from({ length: 13 }, (_, i) => ({
			text: "あ".repeat(16000),
			startUs: 10000000 + i * 30000000,
			endUs: 11000000 + i * 30000000,
		})),
		selectedRanges: Array.from({ length: 13 }, (_, i) => ({
			startUs: 10000000 + i * 30000000,
			endUs: 11000000 + i * 30000000,
		})),
		captionTimingEvidence: {
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			mediaSha256: "0".repeat(64),
			modelSha256: "0".repeat(64),
			qualityPolicyFingerprint: "0".repeat(64),
			transcriptHash: "0".repeat(64),
			rawSegments: [],
			speechIntervals: [],
		},
	};
	await expect(alignSelectedCaptionSegments(input)).rejects.toMatchObject({
		code: "CAPTION_ALIGNMENT_LIMIT",
	});
	expect(execute).not.toHaveBeenCalled();
});

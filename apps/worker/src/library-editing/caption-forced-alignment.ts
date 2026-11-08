import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CAPTION_ALIGNMENT_POLICY,
	type CaptionAlignmentFinalMeasurement,
	type CaptionAlignmentMeasurement,
	type CaptionTimingEvidence,
	type CompositionSourceSegment,
	compositionSourceSegmentSchema,
	currentCaptionAlignmentReceiptSchema,
	hashEditingEvidence,
	matchesFinalCaptionAlignmentMeasurements,
} from "@bitovp/core";
import manifest from "../../native/caption-alignment-model.json" with {
	type: "json",
};
import {
	analysisBudget,
	analysisScratch,
	verifyAnalysisSourceFile,
} from "./analysis-io";
import {
	applyCaptionAlignmentFocus,
	planCaptionAlignmentFocus,
} from "./caption-alignment-focus";
import { MediaOperationError, runMediaProcess } from "./process";

type Range = { startUs: number; endUs: number };
type Window = Range & { requiredEndUs: number; indices: number[] };
function fail(code: string): never {
	throw new MediaOperationError(code);
}
const nativeOutputReasons = [
	"NATIVE_RESULT_COUNT",
	"NATIVE_ITEM_SHAPE",
	"NATIVE_ITEM_TEXT",
	"NATIVE_ITEM_TIME_TYPE",
	"NATIVE_ITEM_NEGATIVE_TIME",
	"NATIVE_ITEM_NONMONOTONIC",
	"NATIVE_ITEM_ZERO_DURATION",
	"NATIVE_ITEM_REVERSED_TIME",
	"NATIVE_ITEM_OUT_OF_WINDOW",
	"NATIVE_DECODER_SHAPE",
	"NATIVE_DECODER_COUNT",
	"NATIVE_DECODER_NONFINITE",
	"NATIVE_DECODER_GRID",
	"NATIVE_DECODER_LEXICAL",
	"NATIVE_DECODER_PARAGRAPH",
	"NATIVE_DECODER_ANCHOR",
] as const;
const boundedIndex = (value: unknown, limit: number): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value >= 0 &&
	value < limit;
function invalidOutput(
	reason:
		| (typeof nativeOutputReasons)[number]
		| "NATIVE_OUTPUT_INVALID"
		| "NODE_JSON_DECODE"
		| "NODE_ERROR_ENVELOPE"
		| "NODE_OUTPUT_CONTRACT"
		| "NODE_ZERO_DURATION_NO_ANCHOR",
	windowIndex?: number,
	itemIndex?: number,
): never {
	try {
		console.warn(
			JSON.stringify({
				event: "caption_alignment_output_rejected",
				errorCode: "CAPTION_ALIGNMENT_OUTPUT_INVALID",
				reason,
				...(boundedIndex(windowIndex, 80)
					? {
							windowIndex,
							...(boundedIndex(itemIndex, 30000) ? { itemIndex } : {}),
						}
					: {}),
			}),
		);
	} catch {
		// Diagnostics must not replace the existing strict rejection.
	}
	throw new MediaOperationError("CAPTION_ALIGNMENT_OUTPUT_INVALID");
}
type AlignerItem = { text: string; startUs: number; endUs: number };
type AlignerOutput = {
	version: string;
	engineVersion: string;
	modelManifestHash: string;
	modelLoadMs: number;
	alignmentMs: number;
	windows: { items: AlignerItem[] }[];
};
const us = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]) =>
	Object.keys(v).length === expected.length &&
	expected.every((key) => Object.hasOwn(v, key));
function parseOutput(raw: unknown): AlignerOutput | undefined {
	if (
		!record(raw) ||
		!keys(raw, [
			"version",
			"engineVersion",
			"modelManifestHash",
			"modelLoadMs",
			"alignmentMs",
			"windows",
		]) ||
		raw.version !== "caption-alignment-output-v1" ||
		raw.engineVersion !== "0.0.6" ||
		typeof raw.modelManifestHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(raw.modelManifestHash)
	)
		return;
	for (const value of [raw.modelLoadMs, raw.alignmentMs])
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < 0 ||
			value > 600000
		)
			return;
	if (
		!Array.isArray(raw.windows) ||
		!raw.windows.length ||
		raw.windows.length > 80
	)
		return;
	for (const window of raw.windows) {
		if (
			!record(window) ||
			!keys(window, ["items"]) ||
			!Array.isArray(window.items) ||
			window.items.length > 30000
		)
			return;
		for (const item of window.items)
			if (
				!record(item) ||
				!keys(item, ["text", "startUs", "endUs"]) ||
				typeof item.text !== "string" ||
				!item.text.length ||
				item.text.length > 16000 ||
				!us(item.startUs) ||
				!us(item.endUs)
			)
				return;
	}
	return raw as AlignerOutput;
}
const errors = new Set([
	"CAPTION_ALIGNMENT_UNAVAILABLE",
	"CAPTION_ALIGNMENT_INPUT_INVALID",
	"CAPTION_ALIGNMENT_MODEL_MISMATCH",
	"CAPTION_ALIGNMENT_RUNTIME_MISMATCH",
	"CAPTION_ALIGNMENT_RUNTIME_FAILED",
	"CAPTION_ALIGNMENT_OUTPUT_INVALID",
	"CAPTION_ALIGNMENT_LANGUAGE_UNSUPPORTED",
	"CAPTION_ALIGNMENT_LIMIT",
]);
const kept = (char: string) => /[\p{L}\p{N}']/u.test(char);
function projection(text: string) {
	const chars: { text: string; start: number; end: number }[] = [];
	let offset = 0;
	for (const char of text) {
		if (kept(char))
			chars.push({ text: char, start: offset, end: offset + char.length });
		offset += char.length;
	}
	return chars;
}
type AlignedWord = NonNullable<CompositionSourceSegment["words"]>[number];
type ZeroGroupContext = {
	windowIndex: number;
	paragraphIndex: number;
	paragraphSelected: boolean;
	selectedRanges: readonly Range[];
	windowStartUs: number;
	windowEndUs: number;
};
function logUnresolvedZeroGroup(
	text: string,
	words: readonly AlignedWord[],
	from: number,
	to: number,
	context: ZeroGroupContext,
) {
	try {
		const first = words[from],
			last = words[to - 1];
		const durationUs = context.windowEndUs - context.windowStartUs;
		const within = (value: number) => us(value) && value <= durationUs;
		if (
			!first ||
			!last ||
			!boundedIndex(context.windowIndex, 80) ||
			!boundedIndex(context.paragraphIndex, 5000) ||
			!boundedIndex(from, 30000) ||
			!Number.isSafeInteger(to) ||
			to <= from ||
			to > words.length ||
			words.length > 30000 ||
			!us(durationUs) ||
			durationUs > 60_000_000
		)
			return;
		const zeroAtUs = first.startUs - context.windowStartUs;
		if (
			!within(zeroAtUs) ||
			!us(first.startChar) ||
			!us(last.endChar) ||
			first.startChar >= last.endChar ||
			last.endChar > text.length
		)
			return;
		const neighbor = (value: AlignedWord | undefined) => {
			if (!value) return null;
			const fromUs = value.startUs - context.windowStartUs,
				toUs = value.endUs - context.windowStartUs;
			if (
				!within(fromUs) ||
				!within(toUs) ||
				toUs < fromUs ||
				!us(value.startChar) ||
				!us(value.endChar) ||
				value.endChar < value.startChar ||
				value.endChar > text.length
			)
				return null;
			return {
				fromUs,
				toUs,
				startChar: value.startChar,
				endChar: value.endChar,
				positive: toUs > fromUs,
			};
		};
		const rawLeft = words[from - 1],
			rawRight = words[to];
		const left = neighbor(rawLeft),
			right = neighbor(rawRight);
		const leftGapUs = left ? zeroAtUs - left.toUs : null,
			rightGapUs = right ? right.fromUs - zeroAtUs : null;
		if (
			(leftGapUs !== null && !within(leftGapUs)) ||
			(rightGapUs !== null && !within(rightGapUs))
		)
			return;
		const charAdjacent = (before: AlignedWord, after: AlignedWord) =>
			before.endChar <= after.startChar &&
			!projection(text.slice(before.endChar, after.startChar)).length;
		console.warn(
			JSON.stringify({
				event: "caption_alignment_zero_group_unresolved",
				windowIndex: context.windowIndex,
				paragraphIndex: context.paragraphIndex,
				paragraphSelected: context.paragraphSelected,
				zeroSelected: context.selectedRanges.some(
					(range) =>
						first.startUs >= range.startUs && first.startUs < range.endUs,
				),
				tokenIndex: from,
				runLength: to - from,
				tokensInParagraph: words.length,
				positiveTokenCount: words.reduce(
					(count, value) => count + Number(value.endUs > value.startUs),
					0,
				),
				zeroAtUs,
				zeroStartChar: first.startChar,
				zeroEndChar: last.endChar,
				left,
				right,
				leftGapUs,
				rightGapUs,
				leftCharAdjacent: left && rawLeft ? charAdjacent(rawLeft, first) : null,
				rightCharAdjacent:
					right && rawRight ? charAdjacent(last, rawRight) : null,
			}),
		);
	} catch {
		// Numeric diagnostics cannot alter the existing strict rejection.
	}
}
function groupZeroDurationWords(
	text: string,
	words: readonly AlignedWord[],
	context: ZeroGroupContext,
): AlignedWord[] {
	const { windowIndex } = context;
	const output: AlignedWord[] = [];
	const adjacent = (left: AlignedWord, right: AlignedWord) =>
		left.endChar <= right.startChar &&
		!projection(text.slice(left.endChar, right.startChar)).length;
	for (let index = 0; index < words.length; ) {
		const first = words[index];
		if (!first) invalidOutput("NODE_ZERO_DURATION_NO_ANCHOR", windowIndex);
		if (first.endUs > first.startUs) {
			output.push({ ...first });
			index++;
			continue;
		}
		let last = first;
		let nextIndex = index + 1;
		while (nextIndex < words.length) {
			const next = words[nextIndex];
			if (
				!next ||
				next.startUs !== first.startUs ||
				next.endUs !== first.startUs ||
				!adjacent(last, next)
			)
				break;
			last = next;
			nextIndex++;
		}
		if (
			!context.selectedRanges.some(
				(range) =>
					first.startUs >= range.startUs && first.startUs < range.endUs,
			)
		) {
			index = nextIndex;
			continue;
		}
		const left = output.at(-1),
			right = words[nextIndex];
		if (left && left.endUs === first.startUs && adjacent(left, first)) {
			output[output.length - 1] = {
				...left,
				endChar: last.endChar,
				text: text.slice(left.startChar, last.endChar),
			};
			index = nextIndex;
		} else if (
			right &&
			right.endUs > right.startUs &&
			right.startUs === first.startUs &&
			adjacent(last, right)
		) {
			output.push({
				...right,
				startChar: first.startChar,
				text: text.slice(first.startChar, right.endChar),
			});
			index = nextIndex + 1;
		} else {
			logUnresolvedZeroGroup(text, words, index, nextIndex, context);
			invalidOutput("NODE_ZERO_DURATION_NO_ANCHOR", windowIndex);
		}
	}
	return output;
}
async function pcmHash(path: string, durationUs: number) {
	const bytes = await readFile(path);
	if (
		bytes.length < 44 ||
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WAVE" ||
		bytes.readUInt32LE(4) + 8 !== bytes.length
	)
		fail("CAPTION_ALIGNMENT_INPUT_INVALID");
	let audio: Buffer | undefined,
		format = false;
	for (let offset = 12; offset + 8 <= bytes.length; ) {
		const size = bytes.readUInt32LE(offset + 4),
			from = offset + 8;
		if (size > bytes.length - from) fail("CAPTION_ALIGNMENT_INPUT_INVALID");
		const name = bytes.toString("ascii", offset, offset + 4);
		if (name === "fmt ") {
			if (
				size < 16 ||
				bytes.readUInt16LE(from) !== 1 ||
				bytes.readUInt16LE(from + 2) !== 1 ||
				bytes.readUInt32LE(from + 4) !== 16000 ||
				bytes.readUInt16LE(from + 14) !== 16
			)
				fail("CAPTION_ALIGNMENT_INPUT_INVALID");
			format = true;
		}
		if (name === "data") {
			if (audio) fail("CAPTION_ALIGNMENT_INPUT_INVALID");
			audio = bytes.subarray(from, from + size);
		}
		offset = from + size + (size % 2);
	}
	if (
		!format ||
		!audio ||
		audio.length % 2 ||
		Math.abs(audio.length / 2 - Math.round(durationUs * 0.016)) > 2
	)
		fail("CAPTION_ALIGNMENT_INPUT_INVALID");
	return createHash("sha256").update(audio).digest("hex");
}

function windowsFor(
	segments: readonly CompositionSourceSegment[],
	selected: readonly Range[],
	origin: number,
	end: number,
): Window[] {
	const targets = segments.flatMap((segment, index) =>
		selected.some(
			(range) => segment.startUs < range.endUs && segment.endUs > range.startUs,
		)
			? [index]
			: [],
	);
	const windows: Window[] = [];
	for (const index of targets) {
		const segment = segments[index];
		if (!segment) fail("CAPTION_ALIGNMENT_INPUT_INVALID");
		if (segment.endUs - segment.startUs > CAPTION_ALIGNMENT_POLICY.maxWindowUs)
			fail("CAPTION_ALIGNMENT_LIMIT");
		const next: Window = {
			startUs: Math.max(
				origin,
				segment.startUs - CAPTION_ALIGNMENT_POLICY.contextUs,
			),
			endUs: Math.min(end, segment.endUs + CAPTION_ALIGNMENT_POLICY.contextUs),
			requiredEndUs: segment.endUs,
			indices: [index],
		};
		// Context is optional; never truncate the paragraph's actual audio.
		if (next.endUs - next.startUs > CAPTION_ALIGNMENT_POLICY.maxWindowUs) {
			next.startUs = segment.startUs;
			next.endUs = segment.endUs;
		}
		const previous = windows.at(-1);
		if (
			previous &&
			next.startUs <= previous.endUs &&
			Math.max(previous.endUs, next.endUs) - previous.startUs <=
				CAPTION_ALIGNMENT_POLICY.maxWindowUs
		) {
			previous.endUs = Math.max(previous.endUs, next.endUs);
			previous.requiredEndUs = segment.endUs;
			previous.indices.push(index);
		} else {
			if (previous && next.startUs < previous.endUs) {
				const boundary =
					previous.requiredEndUs +
					Math.floor((segment.startUs - previous.requiredEndUs) / 2);
				previous.endUs = Math.min(previous.endUs, boundary);
				next.startUs = Math.max(next.startUs, boundary);
			}
			windows.push(next);
		}
	}
	for (const window of windows) {
		// Add nearby paragraphs only if their complete original audio is already inside.
		window.indices = segments.flatMap((s, i) =>
			s.startUs >= window.startUs && s.endUs <= window.endUs ? [i] : [],
		);
	}
	if (!windows.length) fail("CAPTION_ALIGNMENT_INPUT_INVALID");
	if (
		windows.length > 80 ||
		windows.reduce((n, w) => n + w.endUs - w.startUs, 0) >
			CAPTION_ALIGNMENT_POLICY.maxAudioUs
	)
		fail("CAPTION_ALIGNMENT_LIMIT");
	return windows;
}

export type CaptionAlignmentInput = {
	sourcePath: string;
	captionTimingEvidence?: CaptionTimingEvidence;
	mediaSha256: string;
	sourceOriginUs: number;
	sourceDurationUs: number;
	segments: readonly CompositionSourceSegment[];
	selectedRanges: readonly Range[];
	language: "ja" | "en" | "auto";
	signal: AbortSignal;
	ffmpegPath?: string;
	modelPath?: string;
	pythonPath?: string;
	onProgress?: (progress: {
		completedWindows: number;
		totalWindows: number;
	}) => Promise<void>;
};
export function captionAlignmentInputHash(input: CaptionAlignmentInput) {
	return hashEditingEvidence({
		policy: CAPTION_ALIGNMENT_POLICY,
		mediaSha256: input.mediaSha256,
		sourceOriginUs: input.sourceOriginUs,
		sourceDurationUs: input.sourceDurationUs,
		segments: input.segments,
		selectedRanges: input.selectedRanges,
		language: input.language,
		...(input.captionTimingEvidence === undefined
			? {}
			: { captionTimingEvidence: input.captionTimingEvidence }),
	});
}
export async function alignSelectedCaptionSegments(
	input: CaptionAlignmentInput,
) {
	try {
		const budget = analysisBudget(
			input.signal,
			CAPTION_ALIGNMENT_POLICY.timeoutMs,
		);
		budget.check();
		if (input.language !== "ja" && input.language !== "en")
			fail("CAPTION_ALIGNMENT_LANGUAGE_UNSUPPORTED");
		const sourceEndUs = input.sourceOriginUs + input.sourceDurationUs;
		if (
			!Number.isSafeInteger(input.sourceOriginUs) ||
			input.sourceOriginUs < 0 ||
			!Number.isSafeInteger(input.sourceDurationUs) ||
			input.sourceDurationUs < 1 ||
			!Number.isSafeInteger(sourceEndUs) ||
			!isAbsolute(input.sourcePath) ||
			!/^[a-f0-9]{64}$/.test(input.mediaSha256)
		)
			fail("CAPTION_ALIGNMENT_INPUT_INVALID");
		const parsed = compositionSourceSegmentSchema
			.array()
			.min(1)
			.max(5000)
			.safeParse(input.segments);
		const selected = input.selectedRanges;
		if (
			!parsed.success ||
			!Array.isArray(selected) ||
			!selected.length ||
			selected.length > 80 ||
			selected.some(
				(r) =>
					!record(r) ||
					!keys(r, ["startUs", "endUs"]) ||
					!us(r.startUs) ||
					!us(r.endUs) ||
					r.endUs <= r.startUs,
			)
		)
			fail("CAPTION_ALIGNMENT_INPUT_INVALID");
		const segments = parsed.data;
		let priorEnd = input.sourceOriginUs;
		for (const segment of segments) {
			if (segment.startUs < priorEnd || segment.endUs > sourceEndUs)
				fail("CAPTION_ALIGNMENT_INPUT_INVALID");
			priorEnd = segment.endUs;
		}
		if (
			selected.some(
				(r) => r.startUs < input.sourceOriginUs || r.endUs > sourceEndUs,
			)
		)
			fail("CAPTION_ALIGNMENT_INPUT_INVALID");
		const windows = windowsFor(
			segments,
			selected,
			input.sourceOriginUs,
			sourceEndUs,
		);
		const primaryTexts = windows.map((w) =>
			w.indices
				.map(
					(i) => segments[i]?.text ?? fail("CAPTION_ALIGNMENT_INPUT_INVALID"),
				)
				.join(" "),
		);
		const primaryTextChars = primaryTexts.reduce((n, t) => n + t.length, 0);
		if (
			primaryTexts.some((t) => !projection(t).length || t.length > 32000) ||
			primaryTextChars > 200000
		)
			fail("CAPTION_ALIGNMENT_LIMIT");
		const focusPlan = planCaptionAlignmentFocus({
			...input,
			segments,
			remainingTextChars: 200000 - primaryTextChars,
			remainingAudioUs:
				CAPTION_ALIGNMENT_POLICY.maxAudioUs -
				windows.reduce((n, w) => n + w.endUs - w.startUs, 0),
			remainingWindowCount: 80 - windows.length,
		});
		const nativeWindows = [
			...windows.map((w) => ({
				...w,
				paragraphTexts: w.indices.map(
					(i) => segments[i]?.text ?? fail("CAPTION_ALIGNMENT_INPUT_INVALID"),
				),
			})),
			...focusPlan.candidates.map((c) => ({ ...c, paragraphTexts: [c.text] })),
		];
		const texts = nativeWindows.map((w) => w.paragraphTexts.join(" "));
		if (
			texts.some((t) => !projection(t).length || t.length > 32000) ||
			texts.reduce((n, t) => n + t.length, 0) > 200000
		)
			fail("CAPTION_ALIGNMENT_LIMIT");
		const inputHash = captionAlignmentInputHash(input);
		const modelPath =
			input.modelPath ?? "/editing-models/qwen3-forced-aligner-0.6b";
		const pythonPath =
			input.pythonPath ?? "/opt/bitovp-caption-alignment/bin/python";
		if (!isAbsolute(modelPath) || !isAbsolute(pythonPath))
			fail("CAPTION_ALIGNMENT_INPUT_INVALID");
		await verifyAnalysisSourceFile(
			input.sourcePath,
			input.mediaSha256,
			"SOURCE_CHANGED",
			budget,
		);
		const directory = await analysisScratch("bitovp-caption-align-");
		try {
			await input.onProgress?.({
				completedWindows: 0,
				totalWindows: nativeWindows.length,
			});
			const requests: {
				audioPath: string;
				durationUs: number;
				text: string;
				paragraphTexts: string[];
				pcmSha256: string;
			}[] = [];
			for (const [index, window] of nativeWindows.entries()) {
				budget.check();
				const audioPath = join(directory, `audio-${index}.wav`);
				await runMediaProcess(
					input.ffmpegPath ?? "ffmpeg",
					[
						"-nostdin",
						"-hide_banner",
						"-loglevel",
						"error",
						"-threads",
						"1",
						"-protocol_whitelist",
						"file,pipe",
						"-ss",
						((window.startUs - input.sourceOriginUs) / 1000000).toFixed(6),
						"-i",
						input.sourcePath,
						"-map",
						"0:a:0",
						"-vn",
						"-t",
						((window.endUs - window.startUs) / 1000000).toFixed(6),
						"-ac",
						"1",
						"-ar",
						"16000",
						"-c:a",
						"pcm_s16le",
						"-fs",
						String(Math.ceil((window.endUs - window.startUs) * 0.032) + 4096),
						"-y",
						audioPath,
					],
					{
						signal: input.signal,
						timeoutMs: budget.remaining(),
						maxOutputBytes: 1024 * 1024,
					},
				);
				const facts = await stat(audioPath);
				if (
					!facts.isFile() ||
					facts.size < 44 ||
					facts.size > Math.ceil((window.endUs - window.startUs) * 0.032) + 4096
				)
					fail("CAPTION_ALIGNMENT_INPUT_INVALID");
				requests.push({
					audioPath,
					durationUs: window.endUs - window.startUs,
					text: texts[index] ?? fail("CAPTION_ALIGNMENT_INPUT_INVALID"),
					paragraphTexts: window.paragraphTexts,
					pcmSha256: await pcmHash(audioPath, window.endUs - window.startUs),
				});
			}
			const requestPath = join(directory, "request.json");
			await writeFile(
				requestPath,
				JSON.stringify({
					version: "caption-alignment-request-v2",
					modelPath,
					language: input.language,
					windows: requests,
				}),
				{ mode: 0o600 },
			);
			const result = await runMediaProcess(
				pythonPath,
				[
					fileURLToPath(
						new URL("../../scripts/caption-forced-align.py", import.meta.url),
					),
					"--manifest",
					fileURLToPath(
						new URL(
							"../../native/caption-alignment-model.json",
							import.meta.url,
						),
					),
					"--request",
					requestPath,
				],
				{
					signal: input.signal,
					timeoutMs: budget.remaining(),
					maxOutputBytes: 4 * 1024 * 1024,
				},
			);
			let raw: unknown;
			try {
				raw = JSON.parse(result.stdout);
			} catch {
				invalidOutput("NODE_JSON_DECODE");
			}
			if (record(raw) && Object.hasOwn(raw, "error")) {
				if (keys(raw, ["error"]) && typeof raw.error === "string") {
					if (raw.error === "CAPTION_ALIGNMENT_OUTPUT_INVALID")
						invalidOutput("NATIVE_OUTPUT_INVALID");
					fail(
						errors.has(raw.error)
							? raw.error
							: "CAPTION_ALIGNMENT_RUNTIME_FAILED",
					);
				}
				const reason = nativeOutputReasons.find(
					(value) => value === raw.reason,
				);
				const windowIndex = raw.windowIndex,
					itemIndex = raw.itemIndex;
				if (
					raw.error !== "CAPTION_ALIGNMENT_OUTPUT_INVALID" ||
					!reason ||
					!keys(raw, [
						"error",
						"reason",
						...(windowIndex !== undefined ? ["windowIndex"] : []),
						...(itemIndex !== undefined ? ["itemIndex"] : []),
					]) ||
					(windowIndex !== undefined && !boundedIndex(windowIndex, 80)) ||
					(itemIndex !== undefined &&
						(!boundedIndex(windowIndex, 80) || !boundedIndex(itemIndex, 30000)))
				)
					invalidOutput("NODE_ERROR_ENVELOPE");
				invalidOutput(
					reason,
					boundedIndex(windowIndex, 80) ? windowIndex : undefined,
					boundedIndex(itemIndex, 30000) ? itemIndex : undefined,
				);
			}
			const decoded = parseOutput(raw);
			if (
				!decoded ||
				decoded.windows.length !== nativeWindows.length ||
				decoded.modelManifestHash !== hashEditingEvidence(manifest)
			)
				invalidOutput("NODE_OUTPUT_CONTRACT");
			const rawWordCount = decoded.windows.reduce(
				(count, window) => count + window.items.length,
				0,
			);
			if (rawWordCount > 30000) fail("CAPTION_ALIGNMENT_LIMIT");
			let aligned = new Map<number, CompositionSourceSegment>();
			const baseMeasurements: CaptionAlignmentMeasurement[] = [],
				focusMeasurements: CaptionAlignmentMeasurement[] = [];
			const baseWindowBySegment = new Map<number, number>();
			const measure = (
				word: AlignedWord,
				windowIndex: number,
				segmentIndex: number,
			): CaptionAlignmentMeasurement => ({
				timingSource:
					windowIndex < windows.length ? "MODEL_BASE" : "MODEL_FOCUS",
				windowIndex,
				segmentIndex,
				startChar: word.startChar,
				endChar: word.endChar,
				startUs: word.startUs,
				endUs: word.endUs,
			});
			for (const [index, window] of windows.entries()) {
				const text = texts[index] ?? "";
				const chars = projection(text);
				const boundaries: { index: number; from: number; to: number }[] = [];
				let offset = 0;
				for (const segmentIndex of window.indices) {
					const segment = segments[segmentIndex];
					if (!segment) invalidOutput("NODE_OUTPUT_CONTRACT");
					boundaries.push({
						index: segmentIndex,
						from: offset,
						to: offset + segment.text.length,
					});
					offset += segment.text.length + 1;
				}
				let cursor = 0,
					previousEnd = 0,
					boundaryIndex = 0;
				const items = decoded.windows[index]?.items ?? [];
				for (const item of items) {
					const lexical = projection(item.text).map((c) => c.text);
					if (
						!lexical.length ||
						item.endUs < item.startUs ||
						item.startUs < previousEnd ||
						item.endUs > window.endUs - window.startUs
					)
						invalidOutput("NODE_OUTPUT_CONTRACT");
					const span = chars.slice(cursor, cursor + lexical.length);
					if (
						span.length !== lexical.length ||
						span.some((c, i) => c.text !== lexical[i])
					)
						fail("CAPTION_ALIGNMENT_TEXT_MISMATCH");
					cursor += lexical.length;
					previousEnd = item.endUs;
					const first = span[0],
						last = span.at(-1);
					if (!first || !last) invalidOutput("NODE_OUTPUT_CONTRACT");
					while (
						boundaries[boundaryIndex] &&
						first.start >= (boundaries[boundaryIndex]?.to ?? 0)
					)
						boundaryIndex++;
					const boundary = boundaries[boundaryIndex];
					if (
						!boundary ||
						first.start < boundary.from ||
						last.end > boundary.to
					)
						fail("CAPTION_ALIGNMENT_TEXT_MISMATCH");
					const original = segments[boundary.index];
					if (!original) invalidOutput("NODE_OUTPUT_CONTRACT");
					const startChar = first.start - boundary.from,
						endChar = last.end - boundary.from;
					const word = {
						text: original.text.slice(startChar, endChar),
						startChar,
						endChar,
						startUs: window.startUs + item.startUs,
						endUs: window.startUs + item.endUs,
						confidence: 0,
					};
					const target = aligned.get(boundary.index) ?? {
						startUs: word.startUs,
						endUs: word.endUs,
						text: original.text,
						words: [],
					};
					baseWindowBySegment.set(boundary.index, index);
					baseMeasurements.push(measure(word, index, boundary.index));
					target.words?.push(word);
					target.endUs = word.endUs;
					aligned.set(boundary.index, target);
				}
				if (cursor !== chars.length) fail("CAPTION_ALIGNMENT_TEXT_MISMATCH");
				await input.onProgress?.({
					completedWindows: index + 1,
					totalWindows: nativeWindows.length,
				});
			}
			const focusWords = new Map<string, AlignedWord[]>();
			for (const [focusIndex, candidate] of focusPlan.candidates.entries()) {
				const nativeIndex = windows.length + focusIndex,
					items = decoded.windows[nativeIndex]?.items ?? [];
				const expected = projection(candidate.text),
					original = segments[candidate.segmentIndex];
				if (!original) invalidOutput("NODE_OUTPUT_CONTRACT");
				let cursor = 0,
					previousEnd = 0;
				const words: AlignedWord[] = [];
				for (const item of items) {
					if (
						item.endUs < item.startUs ||
						item.startUs < previousEnd ||
						item.endUs > candidate.endUs - candidate.startUs
					)
						invalidOutput("NODE_OUTPUT_CONTRACT");
					const lexical = projection(item.text).map((c) => c.text),
						span = expected.slice(cursor, cursor + lexical.length);
					if (
						!lexical.length ||
						span.length !== lexical.length ||
						span.some((c, i) => c.text !== lexical[i])
					)
						fail("CAPTION_ALIGNMENT_TEXT_MISMATCH");
					cursor += lexical.length;
					previousEnd = item.endUs;
					const first = span[0],
						last = span.at(-1);
					if (!first || !last) invalidOutput("NODE_OUTPUT_CONTRACT");
					const startChar = candidate.startChar + first.start,
						endChar = candidate.startChar + last.end;
					const word = {
						text: original.text.slice(startChar, endChar),
						startChar,
						endChar,
						startUs: candidate.startUs + item.startUs,
						endUs: candidate.startUs + item.endUs,
						confidence: 0,
					};
					words.push(word);
					focusMeasurements.push(
						measure(word, nativeIndex, candidate.segmentIndex),
					);
				}
				if (cursor !== expected.length) fail("CAPTION_ALIGNMENT_TEXT_MISMATCH");
				focusWords.set(candidate.id, words);
				await input.onProgress?.({
					completedWindows: nativeIndex + 1,
					totalWindows: nativeWindows.length,
				});
			}
			// Validate every raw window before applying the caption-only scope gate.
			let omittedOutsideZeroParagraphs = 0;
			for (const [index, window] of windows.entries()) {
				for (const segmentIndex of window.indices) {
					const target = aligned.get(segmentIndex);
					if (!target) continue;
					const rawWords = target.words ?? [];
					if (!rawWords.length)
						invalidOutput("NODE_ZERO_DURATION_NO_ANCHOR", index);
					const words = groupZeroDurationWords(target.text, rawWords, {
						windowIndex: index,
						paragraphIndex: segmentIndex,
						paragraphSelected: selected.some((range) => {
							const paragraph = segments[segmentIndex];
							return (
								paragraph !== undefined &&
								paragraph.startUs < range.endUs &&
								paragraph.endUs > range.startUs
							);
						}),
						selectedRanges: selected,
						windowStartUs: window.startUs,
						windowEndUs: window.endUs,
					});
					if (!words.length) {
						aligned.delete(segmentIndex);
						omittedOutsideZeroParagraphs++;
						continue;
					}
					const first = words[0],
						last = words.at(-1);
					if (!first || !last)
						invalidOutput("NODE_ZERO_DURATION_NO_ANCHOR", index);
					aligned.set(segmentIndex, {
						...target,
						startUs: first.startUs,
						endUs: last.endUs,
						words,
					});
				}
			}
			const baseOutputHash = hashEditingEvidence(
				compositionSourceSegmentSchema
					.array()
					.max(5000)
					.parse(
						[...aligned.entries()].sort(([a], [b]) => a - b).map(([, s]) => s),
					),
			);
			const focused = applyCaptionAlignmentFocus({
				segments,
				base: aligned,
				candidates: focusPlan.candidates,
				focused: focusWords,
				selectedRanges: selected,
				captionTimingEvidence: input.captionTimingEvidence,
				evidence: focusPlan.evidence,
			});
			aligned = focused.aligned;
			const finalMeasurements: CaptionAlignmentFinalMeasurement[] = [];
			for (const [segmentIndex, segment] of [...aligned.entries()].sort(
				([a], [b]) => a - b,
			))
				for (const word of segment.words ?? []) {
					const focusIndex = focusPlan.candidates.findIndex(
						(c) =>
							c.segmentIndex === segmentIndex &&
							focused.outcomes.some(
								(o) =>
									o.id === c.id &&
									(o.outcome === "ADOPTED" ||
										o.outcome === "RAW_SUPPORTED_GROUP"),
							) &&
							c.startChar <= word.startChar &&
							word.endChar <= c.endChar,
					);
					const windowIndex =
						focusIndex >= 0
							? windows.length + focusIndex
							: baseWindowBySegment.get(segmentIndex);
					if (windowIndex === undefined) invalidOutput("NODE_OUTPUT_CONTRACT");
					const candidate = focusPlan.candidates[focusIndex];
					if (
						candidate &&
						focused.outcomes.some(
							(o) =>
								o.id === candidate.id && o.outcome === "RAW_SUPPORTED_GROUP",
						)
					)
						finalMeasurements.push({
							timingSource: "ASR_TOKEN_GROUP",
							focusId: candidate.id,
							segmentIndex,
							startChar: word.startChar,
							endChar: word.endChar,
							startUs: word.startUs,
							endUs: word.endUs,
						});
					else finalMeasurements.push(measure(word, windowIndex, segmentIndex));
				}
			const outputSegments = compositionSourceSegmentSchema
				.array()
				.max(5000)
				.parse(
					[...aligned.entries()].sort(([a], [b]) => a - b).map(([, s]) => s),
				);
			if (
				(!outputSegments.length && omittedOutsideZeroParagraphs === 0) ||
				rawWordCount > 30000 ||
				outputSegments.reduce((n, s) => n + (s.words?.length ?? 0), 0) > 30000
			)
				fail("CAPTION_ALIGNMENT_LIMIT");
			budget.check();
			await verifyAnalysisSourceFile(
				input.sourcePath,
				input.mediaSha256,
				"SOURCE_CHANGED",
				budget,
			);
			const receipt = currentCaptionAlignmentReceiptSchema.parse({
				version: CAPTION_ALIGNMENT_POLICY.version,
				baseOutputHash,
				focusWindows: focusPlan.candidates.map((c, i) => ({
					id: c.id,
					nativeWindowIndex: windows.length + i,
					kind: c.kind,
					segmentIndex: c.segmentIndex,
					startChar: c.startChar,
					endChar: c.endChar,
					rawSegmentIndex: c.rawSegmentIndex,
					rawTokenIndices: c.rawTokenIndices,
					rawStartUs: c.rawStartUs,
					rawEndUs: c.rawEndUs,
					startUs: c.startUs,
					endUs: c.endUs,
					inputTextHash: hashEditingEvidence(c.text),
					pcmSha256: requests[windows.length + i]?.pcmSha256,
					outcome: focused.outcomes[i]?.outcome,
				})),
				...(focusPlan.evidence ? { evidence: focusPlan.evidence } : {}),
				measurements: {
					base: baseMeasurements,
					focus: focusMeasurements,
					final: finalMeasurements,
				},
				engineVersion: CAPTION_ALIGNMENT_POLICY.engineVersion,
				modelRevision: CAPTION_ALIGNMENT_POLICY.modelRevision,
				confidence: "NOT_REPORTED",
				modelManifestHash: hashEditingEvidence(manifest),
				mediaSha256: input.mediaSha256,
				inputHash,
				outputHash: hashEditingEvidence(outputSegments),
				sourceAudioUs: nativeWindows.reduce(
					(n, w) => n + w.endUs - w.startUs,
					0,
				),
				modelLoadMs: decoded.modelLoadMs,
				alignmentMs: decoded.alignmentMs,
				windows: windows.map((w, i) => ({
					startUs: w.startUs,
					endUs: w.endUs,
					inputTextHash: hashEditingEvidence(texts[i]),
					pcmSha256: requests[i]?.pcmSha256,
				})),
			});
			if (!matchesFinalCaptionAlignmentMeasurements(receipt, outputSegments))
				fail("CAPTION_ALIGNMENT_UNVERIFIED");
			return { segments: outputSegments, receipt, warnings: [] as string[] };
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	} catch (error) {
		if (input.signal.aborted) throw new MediaOperationError("CANCELED");
		if (error instanceof MediaOperationError) throw error;
		throw new MediaOperationError("CAPTION_ALIGNMENT_RUNTIME_FAILED");
	}
}

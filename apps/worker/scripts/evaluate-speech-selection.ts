import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSpeechContextWindow,
	captionsFromSourceSegments,
	compileComposition,
	compositionDocumentSchema,
	createPortraitSelectionSearchBudget,
	editingDocumentSchema,
	normalizeSceneAnalysis,
	refinePortraitSelectionBySpeech,
	selectAutoPortraitClips,
	toCompositionDocument,
} from "@bitovp/core";
import { probeEditingMedia } from "../src/library-editing/media";
import { renderCompositionRecipe } from "../src/library-editing/render";
import {
	BASE_MODEL_SHA256,
	transcribeLocalAudio,
} from "../src/library-editing/transcription";

const inputSha256 =
	"498b9b18398810bf742007135530a32f0699516b6f6012c7f063ca1de0583cd7";
const fontSha256 =
	"68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5";
const hash = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");
const fileHash = async (path: string) => hash(await readFile(path));
const uuid = (value: string) => {
	const hex = hash(`speech-native-v1:${value}`);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

type NativeWindow = { from: number; to: number; indices: number[] };
function wholeWindows(shots: number[][], target: number): NativeWindow[] {
	const frames = shots.map(([from = 0, to = 0]) => ({
		from: from * 30,
		to: to * 30,
	}));
	assert(
		frames.every(
			(f) =>
				Number.isSafeInteger(f.from) &&
				Number.isSafeInteger(f.to) &&
				f.to > f.from,
		),
	);
	const windows: NativeWindow[] = [];
	for (let i = 0; i < frames.length; i++) {
		const first = frames[i];
		assert(first);
		for (let j = i; j < frames.length && j - i < 20; j++) {
			const last = frames[j];
			assert(last);
			if (j > i && frames[j - 1]?.to !== last.from) break;
			if (last.to - first.from > target) break;
			windows.push({
				from: first.from,
				to: last.to,
				indices: Array.from({ length: j - i + 1 }, (_, n) => i + n),
			});
		}
	}
	return windows.sort(
		(a, b) =>
			b.to - b.from - (a.to - a.from) ||
			a.from - b.from ||
			a.indices.length - b.indices.length,
	);
}
/** Independent small exhaustive oracle; no production boundary/selection helper is called. */
function observedOracle(input: {
	windows: NativeWindow[];
	context: { fromFrame: number; toFrame: number };
	segments: { startUs: number; endUs: number }[];
	origin: number;
	totalFrames: number;
}) {
	const { windows, context, segments, origin, totalFrames } = input;
	assert(
		segments.length > 0,
		"This public recorded-speech fixture must have actual ASR observations",
	);
	const state = (frame: number) => {
		const t = BigInt(frame) * 1_000_000n;
		const before = (us: number) => (BigInt(us) - BigInt(origin)) * 30n;
		if (
			segments.some((s) => before(s.startUs) < t && t < before(s.endUs)) ||
			(segments.some((s) => before(s.endUs) === t) &&
				segments.some((s) => before(s.startUs) === t))
		)
			return "UNSAFE";
		return frame <= context.fromFrame || frame >= context.toFrame
			? "UNKNOWN"
			: "OBSERVED_GAP";
	};
	const anchor = windows[0];
	assert(anchor);
	const ends = [anchor.from, anchor.to];
	const sourceEdge =
		ends.every(
			(f) =>
				state(f) !== "UNSAFE" &&
				(state(f) !== "UNKNOWN" || f === 0 || f === totalFrames),
		) && ends.some((f) => state(f) === "UNKNOWN");
	const observed = windows.filter(
		(w) => w.from >= context.fromFrame && w.to <= context.toFrame,
	);
	const strict = observed.find(
		(w) => state(w.from) === "OBSERVED_GAP" && state(w.to) === "OBSERVED_GAP",
	);
	const fallback = observed.find(
		(w) => state(w.from) !== "UNSAFE" && state(w.to) !== "UNSAFE",
	);
	const expected = sourceEdge ? anchor : (strict ?? fallback);
	assert(
		expected,
		"The independent oracle found no speech-safe or unknown whole window",
	);
	return {
		expected,
		status: sourceEdge || !strict ? "FALLBACK" : "APPLIED",
		anchorStates: ends.map((frame) => ({ frame, state: state(frame) })),
		selectedStates: [expected.from, expected.to].map((frame) => ({
			frame,
			state: state(frame),
		})),
	};
}

async function main() {
	assert.equal(
		process.argv.length,
		6,
		"source, new output directory, pinned model and managed font are required",
	);
	const [sourceArg, outputArg, modelArg, fontArg] = process.argv.slice(2);
	assert(sourceArg && outputArg && modelArg && fontArg);
	const sourcePath = resolve(sourceArg),
		output = resolve(outputArg),
		modelPath = resolve(modelArg),
		fontPath = resolve(fontArg);
	assert.equal(await fileHash(sourcePath), inputSha256);
	assert.equal(await fileHash(fontPath), fontSha256);
	assert.equal(await fileHash(modelPath), BASE_MODEL_SHA256);
	const ffmpegPath = process.env.FFMPEG_PATH,
		ffprobePath = process.env.FFPROBE_PATH;
	assert(ffmpegPath && ffprobePath, "Use pinned FFmpeg/ffprobe wrappers");
	await mkdir(output);
	const sourcePaths = [
		"./evaluate-speech-selection.ts",
		"../src/library-editing/generation.ts",
		"../src/library-editing/transcription.ts",
		"../src/library-editing/composition-render.ts",
		"../../../packages/core/src/content-editing/speech-boundaries.ts",
		"../../../packages/core/src/content-editing/auto-portrait.ts",
		"../../../packages/core/src/content-editing/semantic-portrait.ts",
		"../../../packages/core/src/content-editing/composition-frame.ts",
		"../../../packages/core/src/content-editing/composition-evidence.ts",
	];
	const implementationHashes = Object.fromEntries(
		await Promise.all(
			sourcePaths.map(async (name) => [
				name,
				await fileHash(fileURLToPath(new URL(name, import.meta.url))),
			]),
		),
	);
	const facts = await probeEditingMedia({
		sourcePath,
		ffprobePath,
		timeoutMs: 90_000,
	});
	assert.equal(facts.frameCount, 420);
	assert.equal(facts.hasAudio, true);
	const mediaVersionId = uuid("media"),
		analysisRevisionId = uuid("analysis"),
		origin = 12_000_000;
	const map = {
		id: uuid("map"),
		mediaVersionId,
		kind: "CFR" as const,
		sourceStartUs: origin,
		sourceEndUs: origin + 14_000_000,
		editingStartFrame: 0,
		editingEndFrame: 420,
		fps: { num: 30 as const, den: 1 as const },
	};
	const report: {
		status: string;
		inputSha256: string;
		modelSha256: string;
		fontSha256: string;
		metadataKind: string;
		implementationHashes: Record<string, string>;
		cases: unknown[];
		error?: string;
	} = {
		status: "RUNNING",
		inputSha256,
		modelSha256: BASE_MODEL_SHA256,
		fontSha256,
		metadataKind: "MANUAL_EVALUATION_FIXTURE_NOT_PROVIDER_AISA",
		implementationHashes,
		cases: [],
	};
	const controller = new AbortController(),
		signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(15 * 60_000),
		]);
	const stop = () => controller.abort(new Error("CANCELED"));
	process.on("SIGINT", stop);
	const pendingRenders: Array<() => Promise<void>> = [];
	const preflight: {
		id: string;
		frames: number;
		canvas: { width: number; height: number };
	}[] = [];
	try {
		for (const scenario of [
			{
				id: "measured-cut-short-context",
				shots: [
					[6, 7],
					[7, 9],
					[9, 11],
					[11, 13],
				],
				target: 120,
			},
			{
				id: "measured-utterance-cut",
				shots: [
					[0.5, 1.5],
					[1.5, 3],
					[3, 6],
					[6, 7.5],
					[7.5, 9],
					[9, 11],
				],
				target: 210,
			},
			{
				id: "source-edge-unknown",
				shots: [
					[0, 3.5],
					[3.5, 6.5],
					[6.5, 8.5],
					[8.5, 14],
				],
				target: 450,
			},
		]) {
			const directory = join(output, scenario.id);
			await mkdir(directory);
			const sceneId = uuid(`${scenario.id}:scene`);
			const analysis = normalizeSceneAnalysis({
				metadata: { version: "manual-native-speech-evaluation" },
				duration: 26,
				scenes: [
					{
						id: sceneId,
						type: "MAIN_CONTENT",
						title: "Manually annotated timing fixture",
						startInSeconds: 12,
						endInSeconds: 26,
						shots: scenario.shots.map(([from = 0, to = 0]) => ({
							startInSeconds: 12 + from,
							endInSeconds: 12 + to,
						})),
					},
				],
			});
			const searchBudget = createPortraitSelectionSearchBudget();
			const selectorInput = {
				analysis,
				timeMap: map,
				targetDurationFrames: scenario.target,
				searchBudget,
			};
			const anchor = selectAutoPortraitClips(selectorInput),
				context = buildSpeechContextWindow({ selection: anchor, timeMap: map });
			await writeFile(
				join(directory, "anchor-context.json"),
				JSON.stringify({ anchor, context, analysis }, null, 2),
			);
			const started = performance.now();
			const transcript = await transcribeLocalAudio({
				sourcePath,
				mediaSha256: inputSha256,
				sourceStartUs: context.mediaStartUs,
				durationUs: context.durationUs,
				language: "en",
				model: { path: modelPath, sha256: BASE_MODEL_SHA256 },
				ffmpegPath,
				whisperPath: process.env.WHISPER_CLI_PATH,
				signal,
				timeoutMs: 10 * 60_000,
			});
			const segments = transcript.segments.map((segment) => ({
				...segment,
				startUs: segment.startUs + origin,
				endUs: segment.endUs + origin,
				...(segment.words
					? {
							words: segment.words.map((word) => ({
								...word,
								startUs: word.startUs + origin,
								endUs: word.endUs + origin,
							})),
						}
					: {}),
			}));
			await writeFile(
				join(directory, "transcript.json"),
				JSON.stringify(
					{
						...transcript,
						segments,
						sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
					},
					null,
					2,
				),
			);
			const refined = refinePortraitSelectionBySpeech({
				...selectorInput,
				policy: "DURATION",
				anchor,
				context,
				segments,
			});
			await writeFile(
				join(directory, "selection.json"),
				JSON.stringify(refined, null, 2),
			);
			const oracle = observedOracle({
				windows: wholeWindows(scenario.shots, scenario.target),
				context,
				segments,
				origin,
				totalFrames: facts.frameCount,
			});
			await writeFile(
				join(directory, "oracle.json"),
				JSON.stringify(oracle, null, 2),
			);
			assert.equal(refined.status, oracle.status);
			assert.equal(
				refined.selection.actualDurationFrames,
				oracle.expected.to - oracle.expected.from,
			);
			assert.deepEqual(
				refined.selection.clips.map((clip) => ({
					sourceInUs: clip.sourceInUs,
					durationFrames: clip.durationFrames,
					shotIndex: clip.shotIndex,
				})),
				oracle.expected.indices.map((index) => {
					const shot = scenario.shots[index];
					assert(shot);
					const [from = 0, to = 0] = shot;
					return {
						sourceInUs:
							origin + Number((BigInt(from * 30) * 1_000_000n + 29n) / 30n),
						durationFrames: (to - from) * 30,
						shotIndex: index,
					};
				}),
			);
			if (scenario.id === "source-edge-unknown") {
				assert.equal(refined.reason, "BOUNDARY_COVERAGE_UNKNOWN");
				assert.equal(refined.selection.actualDurationFrames, 420);
				assert.deepEqual(refined.selection, anchor);
			} else {
				assert(
					oracle.anchorStates.some((boundary) => boundary.state === "UNSAFE"),
					"Initial cut must actually cross measured ASR speech",
				);
				assert(
					oracle.selectedStates.every(
						(boundary) => boundary.state !== "UNSAFE",
					),
				);
				assert(
					refined.selection.actualDurationFrames < anchor.actualDurationFrames,
					"Measured unsafe cut must change the whole-window selection",
				);
			}
			let cursor = 0;
			let document = toCompositionDocument(
				editingDocumentSchema.parse({
					schemaVersion: 1,
					mediaVersionId,
					timeMapId: map.id,
					analysisRevisionId,
					locale: "en",
					sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
					canvas: { width: 1920, height: 1080 },
					fps: { num: 30, den: 1 },
					clips: refined.selection.clips.map((clip, index) => {
						const value = {
							id: uuid(`${scenario.id}:clip:${index}`),
							sourceInUs: clip.sourceInUs,
							durationFrames: clip.durationFrames,
							timelineStartFrame: cursor,
							audio: { mode: "SOURCE" },
							framing: [
								{
									fromFrame: 0,
									toFrame: clip.durationFrames,
									mode: "FIT",
									origin: "MANUAL",
								},
							],
							evidence: {
								sceneId: clip.sceneId,
								shotIndex: clip.shotIndex,
							},
						};
						cursor += clip.durationFrames;
						return value;
					}),
				}),
			);
			const sources = [
				{
					mediaVersionId,
					timeMap: map,
					width: facts.width,
					height: facts.height,
					hasAudio: facts.hasAudio,
				},
			];
			document = captionsFromSourceSegments({
				document,
				sources,
				segments,
				mediaVersionId,
				idFor: (clipId, index) =>
					uuid(`${scenario.id}:${clipId}:caption:${index}`),
			});
			const ceilFrame = (us: number) =>
				Number(((BigInt(us) - BigInt(origin)) * 30n + 999_999n) / 1_000_000n);
			const expectedCaptions = oracle.expected.indices.reduce(
				(total, index) => {
					const shot = scenario.shots[index];
					assert(shot);
					const [from = 0, to = 0] = shot;
					return (
						total +
						segments.filter(
							(segment) =>
								Math.min(to * 30, ceilFrame(segment.endUs)) >
								Math.max(from * 30, ceilFrame(segment.startUs)),
						).length
					);
				},
				0,
			);
			assert.equal(
				document.captions?.length ?? 0,
				expectedCaptions,
				"All cases must preserve exactly the observed caption intersections",
			);
			if (scenario.id === "source-edge-unknown")
				assert(
					expectedCaptions >= 2,
					"Whole-source fallback retains both observed dialogue captions",
				);
			await writeFile(
				join(directory, "document.json"),
				JSON.stringify(document, null, 2),
			);
			document = compositionDocumentSchema.parse(document);
			const plan = compileComposition(document, sources);
			preflight.push({
				id: scenario.id,
				frames: refined.selection.actualDurationFrames,
				canvas: document.canvas,
			});
			pendingRenders.push(async () => {
				const artifact = await renderCompositionRecipe({
					plan,
					sources: [{ mediaVersionId, sourcePath, sourceFacts: facts }],
					destinationPath: join(directory, "composition.mp4"),
					mode: "PREVIEW",
					fontPath,
					ffmpegPath,
					ffprobePath,
					signal,
					timeoutMs: 10 * 60_000,
				});
				assert.equal(
					artifact.frameCount,
					refined.selection.actualDurationFrames,
				);
				assert.equal(artifact.hasAudio, true);
				assert.equal(
					artifact.durationUs,
					(refined.selection.actualDurationFrames / 30) * 1_000_000,
				);
				report.cases.push({
					id: scenario.id,
					anchor,
					context,
					selection: refined.selection,
					status: refined.status,
					reason: refined.reason,
					intervals: refined.intervals,
					rejectedBoundaryCount: refined.rejectedBoundaryCount,
					artifact,
					elapsedMs: Math.round(performance.now() - started),
					captionCount: document.captions?.length ?? 0,
					wordCount:
						document.captions?.reduce(
							(n, caption) => n + (caption.words?.length ?? 0),
							0,
						) ?? 0,
					searchExpansions: searchBudget.usedExpansions,
					warnings: transcript.warnings,
				});
				await writeFile(
					join(output, "report.json"),
					JSON.stringify(report, null, 2),
				);
			});
		}
		assert.equal(preflight.length, 3);
		await writeFile(
			join(output, "preflight.json"),
			JSON.stringify({ status: "PASS", cases: preflight }, null, 2),
		);
		for (const render of pendingRenders) await render();
		for (const [name, expected] of Object.entries(implementationHashes))
			assert.equal(
				await fileHash(fileURLToPath(new URL(name, import.meta.url))),
				expected,
				"Implementation changed during native evaluation",
			);
		assert.equal(await fileHash(sourcePath), inputSha256);
		assert.equal(await fileHash(modelPath), BASE_MODEL_SHA256);
		assert.equal(await fileHash(fontPath), fontSha256);
		report.status = "PASS";
	} catch (error) {
		report.status = "FAIL";
		report.error = error instanceof Error ? error.message : "Evaluation failed";
		throw error;
	} finally {
		process.removeListener("SIGINT", stop);
		await writeFile(
			join(output, "report.json"),
			JSON.stringify(report, null, 2),
		);
	}
	process.stdout.write(
		`${JSON.stringify({ status: report.status, cases: report.cases.length, output })}\n`,
	);
}
main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Evaluation failed"}\n`,
	);
	process.exitCode = 1;
});

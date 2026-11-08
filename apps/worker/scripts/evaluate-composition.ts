import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyTrackedCompositionFraming,
	type CompositionSourceFacts,
	captionsFromSourceSegments,
	compileComposition,
	compositionSourceSegmentSchema,
	evaluateCompositionFrame,
	normalizeSceneAnalysis,
	selectAutoPortraitClips,
	selectSemanticPortraitClips,
	suggestShotFraming,
	toCompositionDocument,
} from "@bitovp/core";
import {
	type EditingMediaFacts,
	probeEditingMedia,
} from "../src/library-editing/media";
import { runMediaProcess } from "../src/library-editing/process";
import { renderCompositionRecipe } from "../src/library-editing/render";
import {
	type TrackingBox,
	type TrackingShot,
	trackShotSubjects,
} from "../src/library-editing/tracking";

const version = "composition-evaluation-v1";
const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const shaFile = async (path: string) => hash(await readFile(path));
const uuid = (name: string) => {
	const value = hash(`${version}:${name}`);
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
const html = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);
type Scenario = {
	id: string;
	title: string;
	kind: "REAL_ANIMATION" | "SYNTHETIC_GUARD" | "COMPOSITE_REAL_SPEECH";
	from: number;
	to: number;
	seed?: TrackingBox;
	seedAt?: number;
	note: string;
	multi?: boolean;
	speech?: boolean;
};
const scenarios: Scenario[] = [
	{
		id: "closeup-motion",
		title: "アニメーションの頭部移動と大きさ",
		kind: "REAL_ANIMATION",
		from: 30,
		to: 34,
		seed: { x: 0.32, y: 0.18, w: 0.12, h: 0.25 },
		note: "実フレーム30秒の眼付近を手動 seed。初回27秒の別画角 seed と全12候補の失敗・短い成功も別保存している。閾値は変更せず実測移動・大きさ変化だけを採用し、ロスト後は FIT。",
	},
	{
		id: "fast-motion-cut",
		title: "速い移動とカットでの追跡ロスト",
		kind: "REAL_ANIMATION",
		from: 18,
		to: 24,
		seed: { x: 0.57, y: 0.34, w: 0.18, h: 0.42 },
		note: "走行・ジャンプ・画角変化を含む実映像。追跡に失敗しても推定位置を継ぎ足さず FIT。",
	},
	{
		id: "fence-occlusion",
		title: "柵による遮蔽と再出現",
		kind: "REAL_ANIMATION",
		from: 45,
		to: 51,
		seed: { x: 0.48, y: 0.2, w: 0.12, h: 0.24 },
		note: "柵・画角変化を含む実映像。seed は頭部の手動領域で、人や物の検出結果ではない。",
	},
	{
		id: "multiple-subject-guard",
		title: "複数被写体で選択を要求する guard",
		kind: "SYNTHETIC_GUARD",
		from: 0,
		to: 4,
		multi: true,
		note: "同じ実映像を左右反転して二面合成した意図的な検査素材。自然な複数人物や実 AISA 出力とは呼ばない。対象未選択なので NO_SEED / FIT。",
	},
	{
		id: "actual-speech-caption",
		title: "実録音の実測単語字幕と別映像の合成",
		kind: "COMPOSITE_REAL_SPEECH",
		from: 27,
		to: 38,
		speech: true,
		seedAt: 28,
		seed: { x: 0.32, y: 0.18, w: 0.12, h: 0.25 },
		note: "JFK の実録音と実 ASR の単語時刻を、別のアニメーションへ意図的に重ねる合成検査。映像の話者がこの音声を発したとは主張しない。",
	},
];

export async function evaluateComposition(input: {
	sourcePath: string;
	outputDirectory: string;
	speechAudioPath: string;
	transcriptPath: string;
	fontPath: string;
	ffmpegPath?: string;
	ffprobePath?: string;
}) {
	const output = resolve(input.outputDirectory);
	await mkdir(output, { recursive: true });
	const footage = join(output, "footage");
	await mkdir(footage, { recursive: true });
	const ffmpeg = input.ffmpegPath ?? "ffmpeg",
		ffprobe = input.ffprobePath ?? "ffprobe";
	const command = (args: string[]) =>
		runMediaProcess(
			ffmpeg,
			["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
			{ timeoutMs: 600000 },
		);
	const original = join(footage, "caminandes2-original.mp4");
	if (resolve(input.sourcePath) !== original)
		await copyFile(input.sourcePath, original);
	const originalSha256 = await shaFile(original);
	assert.equal(
		originalSha256,
		"7c0f22495d7e6d33576068af668aa887e4dfbe38690c8f6b75ae953c9df80aea",
		"This evaluation's source/seed annotations require the pinned Caminandes file",
	);
	const implementationPaths = {
		tracking: fileURLToPath(
			new URL("../src/library-editing/tracking.ts", import.meta.url),
		),
		renderer: fileURLToPath(
			new URL("../src/library-editing/composition-render.ts", import.meta.url),
		),
		frameEvaluator: fileURLToPath(
			new URL(
				"../../../packages/core/src/content-editing/composition-frame.ts",
				import.meta.url,
			),
		),
		selectionBaseline: fileURLToPath(
			new URL(
				"../../../packages/core/src/content-editing/auto-portrait.ts",
				import.meta.url,
			),
		),
		selectionCohesion: fileURLToPath(
			new URL(
				"../../../packages/core/src/content-editing/semantic-portrait.ts",
				import.meta.url,
			),
		),
		analysisNormalizer: fileURLToPath(
			new URL(
				"../../../packages/core/src/content-library/analysis.ts",
				import.meta.url,
			),
		),
		runner: fileURLToPath(import.meta.url),
		font: resolve(input.fontPath),
	};
	const implementationSha256 = Object.fromEntries(
		await Promise.all(
			Object.entries(implementationPaths).map(async ([key, path]) => [
				key,
				await shaFile(path),
			]),
		),
	);
	const prepared = join(footage, "caminandes2-evaluation-cfr30.mp4");
	const prepareArgs = [
		"-y",
		"-i",
		original,
		"-t",
		"60",
		"-vf",
		"fps=fps=30:start_time=0:round=up,scale=640:360:flags=lanczos,setsar=1",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"20",
		"-threads",
		"2",
		"-pix_fmt",
		"yuv420p",
		"-r",
		"30",
		"-frames:v",
		"1800",
		"-c:a",
		"aac",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-video_track_timescale",
		"30000",
		"-color_primaries",
		"bt709",
		"-color_trc",
		"bt709",
		"-colorspace",
		"bt709",
		"-x264-params",
		"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		"-movflags",
		"+faststart",
		prepared,
	];
	const preparationStart = performance.now();
	const previous: unknown = await readFile(
		join(footage, "provenance.json"),
		"utf8",
	)
		.then((value) => JSON.parse(value))
		.catch(() => null);
	const existingSha = await shaFile(prepared).catch(() => null);
	const preparationReused =
		previous !== null &&
		typeof previous === "object" &&
		"originalSha256" in previous &&
		previous.originalSha256 === originalSha256 &&
		"preparedSha256" in previous &&
		previous.preparedSha256 === existingSha &&
		"recipe" in previous &&
		hash(JSON.stringify(previous.recipe)) === hash(JSON.stringify(prepareArgs));
	if (!preparationReused) await command(prepareArgs);
	const preparationMs = performance.now() - preparationStart;
	const preparedSha256 = await shaFile(prepared),
		primaryFacts = await probeEditingMedia({
			sourcePath: prepared,
			ffprobePath: ffprobe,
		});
	assert.equal(primaryFacts.frameCount, 1800);
	await writeFile(
		join(footage, "provenance.json"),
		JSON.stringify(
			{
				version,
				originalSha256,
				preparedSha256,
				originalPath: original,
				preparationMs,
				preparationReused,
				recipe: prepareArgs,
				source:
					"Blender Foundation Caminandes 2 Gran Dillama, CC BY 3.0 (actual file credits at144s)",
				licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
				sourceUrl: "https://studio.blender.org/films/caminandes-2/",
				provenance: "REAL_ANIMATION_WITH_EXPLICIT_EVALUATION_TRANSFORM",
				limitations: [
					"Original has no BT709 color tags. Evaluation explicitly assigns SDR709 and scales640x360. This is an annotated test derivative, not a production NORMALIZATION_CAPTURE receipt.",
					"Scene intervals, descriptions and subject seeds are manual evaluation fixtures; no provider AISA analysis or binding is asserted.",
				],
			},
			null,
			2,
		),
	);
	await command([
		"-y",
		"-ss",
		"144",
		"-i",
		original,
		"-frames:v",
		"1",
		join(footage, "source-license-frame.png"),
	]);
	const multiple = join(footage, "multiple-subject-guard.mp4");
	await command([
		"-y",
		"-ss",
		"27",
		"-i",
		prepared,
		"-t",
		"4",
		"-filter_complex",
		"[0:v]split=2[a][b];[a]scale=320:180[a1];[b]hflip,scale=320:180[b1];[a1][b1]hstack,pad=640:360:0:90[v]",
		"-map",
		"[v]",
		"-map",
		"0:a:0?",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-threads",
		"2",
		"-pix_fmt",
		"yuv420p",
		"-r",
		"30",
		"-frames:v",
		"120",
		"-c:a",
		"aac",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-video_track_timescale",
		"30000",
		"-color_primaries",
		"bt709",
		"-color_trc",
		"bt709",
		"-colorspace",
		"bt709",
		"-x264-params",
		"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		multiple,
	]);
	const multipleFacts = await probeEditingMedia({
		sourcePath: multiple,
		ffprobePath: ffprobe,
	});
	const speechSource = join(footage, "jfk-actual-audio.mp4");
	await command([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=black:s=640x360:r=30:d=11",
		"-i",
		resolve(input.speechAudioPath),
		"-map",
		"0:v:0",
		"-map",
		"1:a:0",
		"-t",
		"11",
		"-frames:v",
		"330",
		"-c:v",
		"libx264",
		"-threads",
		"2",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-video_track_timescale",
		"30000",
		"-color_primaries",
		"bt709",
		"-color_trc",
		"bt709",
		"-colorspace",
		"bt709",
		"-x264-params",
		"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		speechSource,
	]);
	const speechFacts = await probeEditingMedia({
		sourcePath: speechSource,
		ffprobePath: ffprobe,
	});
	const transcript: unknown = JSON.parse(
		await readFile(input.transcriptPath, "utf8"),
	);
	assert(
		transcript &&
			typeof transcript === "object" &&
			"segments" in transcript &&
			Array.isArray(transcript.segments),
	);
	assert(
		"mediaSha256" in transcript &&
			transcript.mediaSha256 === (await shaFile(input.speechAudioPath)),
	);
	const segments = transcript.segments.map((segment) =>
		compositionSourceSegmentSchema.parse(segment),
	);
	assert(segments.some((segment) => (segment.words?.length ?? 0) > 0));
	const makeSource = (
		name: string,
		facts: EditingMediaFacts,
	): CompositionSourceFacts => ({
		mediaVersionId: uuid(`${name}:media`),
		width: facts.width,
		height: facts.height,
		hasAudio: facts.hasAudio,
		timeMap: {
			id: uuid(`${name}:map`),
			mediaVersionId: uuid(`${name}:media`),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: facts.durationUs,
			editingStartFrame: 0,
			editingEndFrame: facts.frameCount,
			fps: { num: 30, den: 1 },
		},
	});
	const primary = makeSource("film", primaryFacts),
		multiSource = makeSource("multi", multipleFacts),
		voice = makeSource("voice", speechFacts);
	const results = [];
	for (const scenario of scenarios) {
		const directory = join(output, scenario.id);
		await mkdir(directory, { recursive: true });
		const source = scenario.multi ? multiSource : primary,
			sourcePath = scenario.multi ? multiple : prepared,
			sourceFacts = scenario.multi ? multipleFacts : primaryFacts;
		const mediaSha256 = await shaFile(sourcePath),
			sceneId = uuid(`${scenario.id}:scene`),
			analysisId = uuid(`${scenario.id}:manual-analysis`),
			clipId = uuid(`${scenario.id}:clip`);
		const requestedDurationFrames = scenario.speech ? 360 : 300;
		const analysis = normalizeSceneAnalysis({
			metadata: { version: "evaluation-manual-fixture-v1" },
			duration: sourceFacts.durationUs / 1000000,
			scenes: [
				{
					id: sceneId,
					type: "MAIN_CONTENT",
					title: scenario.title,
					summary: scenario.note,
					startInSeconds: scenario.from,
					endInSeconds: scenario.to,
					shots: [
						{
							startInSeconds: scenario.from,
							endInSeconds: scenario.to,
							detailedDescription: scenario.note,
						},
					],
				},
			],
		});
		const selection = selectSemanticPortraitClips({
			analysis,
			timeMap: source.timeMap,
			targetDurationFrames: requestedDurationFrames,
		});
		assert.equal(selection.clips.length, 1);
		const selected = selection.clips[0];
		assert(selected);
		let document = toCompositionDocument({
			schemaVersion: 1,
			mediaVersionId: source.mediaVersionId,
			timeMapId: source.timeMap.id,
			analysisRevisionId: analysisId,
			locale: scenario.speech ? "en" : "ja",
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			canvas: { width: 1080, height: 1920 },
			fps: { num: 30, den: 1 },
			clips: [
				{
					id: clipId,
					sourceInUs: selected.sourceInUs,
					durationFrames: selected.durationFrames,
					timelineStartFrame: 0,
					framing: [
						{
							fromFrame: 0,
							toFrame: selected.durationFrames,
							mode: "FIT",
							origin: "MANUAL",
						},
					],
					audio: { mode: scenario.speech ? "MUTE" : "SOURCE" },
					evidence: { sceneId, shotIndex: 0 },
				},
			],
		});
		const shots: TrackingShot[] = [
			{
				sceneId,
				shotIndex: 0,
				startUs: selected.sourceInUs,
				endUs:
					selected.sourceInUs +
					Math.floor((selected.durationFrames * 1000000) / 30),
				...(scenario.seed
					? {
							seed: {
								sourceTimeUs:
									scenario.seedAt === undefined
										? selected.sourceInUs
										: Math.round(scenario.seedAt * 1000000),
								box: scenario.seed,
							},
						}
					: {}),
			},
		];
		const trackInput = {
			sourcePath,
			mediaSha256,
			sourceWidth: source.width,
			sourceHeight: source.height,
			shots,
			ffmpegPath: ffmpeg,
			timeoutMs: 180000,
		};
		const coldStart = performance.now();
		const tracking = await trackShotSubjects(trackInput);
		const coldTrackingMs = performance.now() - coldStart;
		const warmStart = performance.now();
		const warmTracking = await trackShotSubjects(trackInput);
		const warmTrackingMs = performance.now() - warmStart;
		assert.deepEqual(warmTracking, tracking);
		if (scenario.id === "closeup-motion") {
			assert(
				tracking.observations.length >= 2,
				"The positive real-motion control requires multiple measured frames",
			);
			const first = tracking.observations[0];
			assert(first);
			assert(
				tracking.observations.some(
					(point) => point.box.x !== first.box.x || point.box.y !== first.box.y,
				),
				"The positive real-motion control must measure movement",
			);
		}
		document = applyTrackedCompositionFraming({
			document,
			sources: [source],
			mediaVersionId: source.mediaVersionId,
			observations: tracking.observations,
			fallbacks: tracking.fallbacks,
		});
		const sourceInputs = [
			{ mediaVersionId: source.mediaVersionId, sourcePath, sourceFacts },
		];
		const facts = [source];
		if (scenario.speech) {
			document.sources = [
				{ mediaVersionId: voice.mediaVersionId, timeMapId: voice.timeMap.id },
			];
			document.videoTracks = [
				{ id: "main", name: "Animation", order: 0 },
				{ id: "voice", name: "Invisible speech clock", order: 1 },
			];
			document.clips.push({
				id: uuid("voice:clip"),
				mediaVersionId: voice.mediaVersionId,
				trackId: "voice",
				sourceInUs: 0,
				durationFrames: selected.durationFrames,
				timelineStartFrame: 0,
				opacity: 0,
				framing: [
					{
						fromFrame: 0,
						toFrame: selected.durationFrames,
						mode: "FIT",
						origin: "MANUAL",
					},
				],
				audio: { mode: "MUTE" },
			});
			document.audioTracks = [
				{
					id: uuid("voice:audio"),
					mediaVersionId: voice.mediaVersionId,
					sourceInUs: 0,
					timelineStartFrame: 0,
					durationFrames: selected.durationFrames,
					gainDb: 0,
					fadeInFrames: 0,
					fadeOutFrames: 0,
				},
			];
			document.captionLayout = { x: 0.05, y: 0.6, w: 0.9, h: 0.35 };
			document.captionStyle = { fontSize: 0.04 };
			facts.push(voice);
			sourceInputs.push({
				mediaVersionId: voice.mediaVersionId,
				sourcePath: speechSource,
				sourceFacts: speechFacts,
			});
			document = captionsFromSourceSegments({
				document,
				sources: facts,
				mediaVersionId: voice.mediaVersionId,
				segments,
				idFor: (_id, index) => uuid(`jfk:caption:${index}`),
			});
		}
		const plan = compileComposition(document, facts);
		const outputPath = join(directory, "composition.mp4"),
			warmPath = join(directory, "warm-composition.mp4");
		await rm(outputPath, { force: true });
		await rm(warmPath, { force: true });
		const renderInput = {
			plan,
			sources: sourceInputs,
			destinationPath: outputPath,
			mode: "PREVIEW" as const,
			fontPath: input.fontPath,
			ffmpegPath: ffmpeg,
			ffprobePath: ffprobe,
			timeoutMs: 600000,
		};
		const renderStart = performance.now();
		const rendered = await renderCompositionRecipe(renderInput);
		const coldRenderMs = performance.now() - renderStart;
		const renderWarmStart = performance.now();
		const renderedWarm = await renderCompositionRecipe({
			...renderInput,
			destinationPath: warmPath,
		});
		const warmRenderMs = performance.now() - renderWarmStart;
		assert.equal(rendered.frameCount, selection.actualDurationFrames);
		assert.equal(renderedWarm.frameCount, rendered.frameCount);
		assert.equal(rendered.width, 360);
		assert.equal(rendered.height, 640);
		assert(rendered.hasAudio);
		const audioMetadata = await runMediaProcess(ffprobe, [
			"-v",
			"error",
			"-i",
			outputPath,
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=sample_rate,duration_ts,time_base",
			"-of",
			"json",
		]);
		const audio: unknown = JSON.parse(audioMetadata.stdout);
		const pcmPath = join(directory, "audio-mono.f32");
		await command([
			"-y",
			"-i",
			outputPath,
			"-map",
			"0:a:0",
			"-ar",
			"48000",
			"-ac",
			"1",
			"-f",
			"f32le",
			pcmPath,
		]);
		const pcm = await readFile(pcmPath);
		assert.equal(pcm.length % 4, 0);
		let energy = 0,
			peak = 0,
			nonzeroSamples = 0;
		for (let offset = 0; offset < pcm.length; offset += 4) {
			const sample = pcm.readFloatLE(offset);
			assert(Number.isFinite(sample));
			energy += sample * sample;
			peak = Math.max(peak, Math.abs(sample));
			if (sample !== 0) nonzeroSamples++;
		}
		const decodedSamples = pcm.length / 4,
			rms = Math.sqrt(energy / Math.max(1, decodedSamples));
		assert(
			decodedSamples >= plan.durationFrames * 1600 &&
				decodedSamples <= plan.durationFrames * 1600 + 1024,
			"Decoded audio may include at most one AAC packet of end padding",
		);
		if (scenario.speech)
			assert(
				rms > 0.0001,
				"The actual speech control must contain audible decoded samples",
			);
		const sampleFrames = [
			0,
			...[0.2, 0.4, 0.6, 0.8].map((p) =>
				Math.floor((plan.durationFrames - 1) * p),
			),
			plan.durationFrames - 1,
		];
		const select = sampleFrames.map((frame) => `eq(n\\,${frame})`).join("+");
		await command([
			"-y",
			"-i",
			outputPath,
			"-vf",
			`select=${select},scale=180:320,tile=3x2`,
			"-frames:v",
			"1",
			join(directory, "contact-sheet.png"),
		]);
		await command([
			"-y",
			"-ss",
			String(scenario.seedAt ?? scenario.from),
			"-i",
			sourcePath,
			"-vf",
			"scale=640:360",
			"-frames:v",
			"1",
			join(directory, "seed-frame.png"),
		]);
		const seedImage = (
			await readFile(join(directory, "seed-frame.png"))
		).toString("base64");
		const seed = scenario.seed;
		const annotated = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="390" viewBox="0 0 640 390"><rect width="640" height="390" fill="#111827"/><image href="data:image/png;base64,${seedImage}" width="640" height="360"/>${seed ? `<rect x="${seed.x * 640}" y="${seed.y * 360}" width="${seed.w * 640}" height="${seed.h * 360}" fill="none" stroke="#22c55e" stroke-width="2"/>` : ""}<text x="10" y="380" fill="white" font-family="sans-serif" font-size="14">${seed ? "Manual seed on an actual decoded source frame" : "Synthetic multi-view fixture: target deliberately not selected"}</text></svg>`;
		await writeFile(join(directory, "seed-annotation.svg"), annotated);
		const fitWindows = plan.clips
			.filter((item) => item.clip.id === clipId)
			.flatMap((item) =>
				item.clip.framing
					.filter((part) => part.mode === "FIT")
					.map((part) => ({
						fromFrame: part.fromFrame + item.outputFromFrame,
						toFrame: part.toFrame + item.outputFromFrame,
					})),
			);
		const cropObservationCoverage = tracking.observations.flatMap((point) => {
			const local =
				Math.floor((point.sourceTimeUs * 30) / 1000000) -
				Math.floor((selected.sourceInUs * 30) / 1000000);
			if (local < 0 || local >= plan.durationFrames) return [];
			const layer = evaluateCompositionFrame(plan, local).layers.find(
				(item) => item.clipId === clipId,
			);
			if (layer?.mode !== "CROP" || !layer.cropRect) return [];
			const r = layer.cropRect,
				b = point.box;
			const inside =
				Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x)) *
				Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y));
			return [
				{
					frame: local,
					confidence: point.confidence,
					boxAreaCoverage: inside / (b.w * b.h),
				},
			];
		});
		const multipleSubjectProposal = scenario.multi
			? suggestShotFraming({
					sourceWidth: source.width,
					sourceHeight: source.height,
					targetWidth: 1080,
					targetHeight: 1920,
					coordinateSpaceVerified: true,
					mainSubjects: [
						{ centerX: 25, centerY: 50 },
						{ centerX: 75, centerY: 50 },
					],
				})
			: undefined;
		const metrics = {
			id: scenario.id,
			title: scenario.title,
			kind: scenario.kind,
			note: scenario.note,
			metadataProvenance: "MANUAL_EVALUATION_FIXTURE_NOT_PROVIDER_AISA",
			implementationSha256,
			sourceSha256: mediaSha256,
			sourceIntervalSeconds: [scenario.from, scenario.to],
			requestedDurationFrames,
			selectedDurationFrames: selection.actualDurationFrames,
			selectedDurationSeconds: selection.actualDurationFrames / 30,
			actualEncodedFrames: rendered.frameCount,
			analysisSha256: hash(JSON.stringify(analysis)),
			durationComparisons: [15, 30, 60].map((requestedSeconds) => {
				const input = {
					analysis,
					timeMap: source.timeMap,
					targetDurationFrames: requestedSeconds * 30,
				};
				const baseline = selectAutoPortraitClips(input),
					current = selectSemanticPortraitClips(input),
					sameClips =
						JSON.stringify(current.clips) === JSON.stringify(selection.clips);
				return {
					requestedSeconds,
					baseline,
					current,
					outputVerified: sameClips,
					outputSha256: sameClips ? rendered.sha256 : null,
					outputEvidence: sameClips
						? "Measured MP4 reused for exactly equal selected clips; not a new render"
						: "Different selection has not been rendered",
				};
			}),
			humanQuality: {
				narrativeCompleteness: null,
				subjectRetention: null,
				manualCorrectionCount: null,
				status: "UNMEASURED_NOT_INFERRED_FROM_TEST_PASS",
			},
			actualAudio: {
				probe: audio,
				decodedSamples,
				rms,
				peak,
				nonzeroSamples,
				paddingSamples: decodedSamples - plan.durationFrames * 1600,
			},
			tracking: {
				algorithm: tracking.algorithm,
				manualSeed: shots[0]?.seed,
				acceptedObservations: tracking.observations.length,
				measuredWindowExtent: tracking.observations.length
					? {
							widthSourcePx: [
								Math.min(
									...tracking.observations.map(
										(point) => point.box.w * source.width,
									),
								),
								Math.max(
									...tracking.observations.map(
										(point) => point.box.w * source.width,
									),
								),
							],
							heightSourcePx: [
								Math.min(
									...tracking.observations.map(
										(point) => point.box.h * source.height,
									),
								),
								Math.max(
									...tracking.observations.map(
										(point) => point.box.h * source.height,
									),
								),
							],
							centerXSourcePx: [
								Math.min(
									...tracking.observations.map(
										(point) => (point.box.x + point.box.w / 2) * source.width,
									),
								),
								Math.max(
									...tracking.observations.map(
										(point) => (point.box.x + point.box.w / 2) * source.width,
									),
								),
							],
							centerYSourcePx: [
								Math.min(
									...tracking.observations.map(
										(point) => (point.box.y + point.box.h / 2) * source.height,
									),
								),
								Math.max(
									...tracking.observations.map(
										(point) => (point.box.y + point.box.h / 2) * source.height,
									),
								),
							],
						}
					: null,
				fallbacks: tracking.fallbacks,
				fitWindows,
				cropObservationCoverage,
			},
			captions: (document.captions ?? []).map((caption) => ({
				text: caption.text,
				fromFrame: caption.fromFrame,
				toFrame: caption.toFrame,
				actualWords: caption.words ?? [],
			})),
			multipleSubjectProposal,
			timing: {
				coldTrackingMs,
				warmTrackingMs,
				coldRenderMs,
				warmRenderMs,
				coldDefinition:
					"First call in this runner; OS/file caches are not flushed",
				warmDefinition:
					"Immediate second full algorithm/render run; not a database/cache hit",
			},
			output: {
				...rendered,
				warmSha256: renderedWarm.sha256,
				sameEncodedBytes: renderedWarm.sha256 === rendered.sha256,
			},
			limitations: [
				"No human highlight-quality or tracking-accuracy score is inferred.",
				"Coverage compares the chosen crop with the algorithm's own measured boxes; it is not independent ground truth.",
				"No provider AISA credentials or automatic binding proof were used.",
			],
		};
		await writeFile(
			join(directory, "metrics.json"),
			JSON.stringify(metrics, null, 2),
		);
		await writeFile(
			join(directory, "document.json"),
			JSON.stringify(document, null, 2),
		);
		await writeFile(
			join(directory, "manual-analysis-fixture.json"),
			JSON.stringify(analysis, null, 2),
		);
		await writeFile(
			join(directory, "tracking.json"),
			JSON.stringify(tracking, null, 2),
		);
		await writeFile(
			join(directory, "selection.json"),
			JSON.stringify(selection, null, 2),
		);
		results.push(metrics);
		console.log(
			JSON.stringify({
				case: scenario.id,
				frames: rendered.frameCount,
				observations: tracking.observations.length,
				fitWindows,
				coldTrackingMs,
				warmTrackingMs,
				coldRenderMs,
				warmRenderMs,
			}),
		);
	}
	await writeFile(
		join(output, "duration-matrix.json"),
		JSON.stringify(
			{
				version: "composition-duration-evaluation-v1",
				implementationSha256,
				naturalPatternAvailability: {
					conversation: "Separate Sintel original-audio Docker evaluation",
					moving: "Caminandes animation",
					multiplePeople:
						"UNAVAILABLE; reflected two-view synthetic guard only",
					animation: "Caminandes",
					onScreenText: "UNAVAILABLE; authored text-overlay proof is separate",
				},
				entries: results.map((result) => ({
					id: result.id,
					metadataProvenance: result.metadataProvenance,
					sourceSha256: result.sourceSha256,
					analysisSha256: result.analysisSha256,
					durationComparisons: result.durationComparisons,
					humanQuality: result.humanQuality,
				})),
			},
			null,
			2,
		),
	);
	await writeFile(
		join(output, "metrics.json"),
		JSON.stringify(
			{ version, preparationMs, implementationSha256, scenarios: results },
			null,
			2,
		),
	);
	for (const [key, path] of Object.entries(implementationPaths))
		assert.equal(
			await shaFile(path),
			implementationSha256[key],
			`Evaluation implementation changed during run: ${key}`,
		);
	const cards = results
		.map(
			(result) =>
				`<article><h2>${html(result.title)}</h2><p class="kind">${html(result.kind)}</p><p>${html(result.note)}</p><div class="media"><video controls preload="metadata" src="${result.id}/composition.mp4"></video><img alt="実際の出力6フレーム" src="${result.id}/contact-sheet.png"/></div><p>希望 ${result.requestedDurationFrames / 30} 秒 → 選択 ${result.selectedDurationSeconds} 秒、実出力 ${result.actualEncodedFrames} frames。実測追跡点 ${result.tracking.acceptedObservations} 件。</p><details><summary>手動 seed と数値記録</summary><img alt="実フレーム上の手動 seed。AISA 観測ではありません" src="${result.id}/seed-annotation.svg"/><pre>${html(JSON.stringify(result, null, 2))}</pre></details><p><a href="${result.id}/metrics.json">metrics.json</a> · <a href="${result.id}/document.json">編集文書</a> · <a href="${result.id}/tracking.json">実測 tracking</a></p></article>`,
		)
		.join("");
	await writeFile(
		join(output, "index.html"),
		`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Content Library 合成評価・5 scenarios</title><style>body{margin:0;background:#f4f6f8;color:#15212d;font:16px/1.7 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:28px 20px}h1{font-size:28px}article{margin:28px 0;padding:24px;background:white;border:1px solid #d5dce3;border-radius:12px}h2{margin-top:0;font-size:21px}.kind{font:13px monospace;color:#475569}.media{display:grid;grid-template-columns:minmax(180px,280px) 1fr;gap:20px;align-items:start}video{width:100%;max-height:500px;background:black}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace}a{color:#1358a2}@media(max-width:700px){.media{grid-template-columns:1fr}video{max-height:460px}}</style><main><h1>Content Library 合成評価・5 scenarios</h1><p>実フレーム、実 MP4、実測時刻を確認するための資料です。scene 境界・説明・seed は手動 fixture です。実 AISA provider の出力や解析品質とは扱いません。元映像は Blender Foundation <em>Caminandes 2: Gran Dillama</em>（CC BY）。元ファイルの未指定色 metadata は評価用に明示 SDR709 として処理しており、production normalization receipt は作成していません。</p><p>複数被写体 guard は二面合成素材、音声字幕は実 JFK 録音を別映像へ重ねた意図的な合成です。warm は同じ処理の直後再実行で、DB cache hit の性能値ではありません。<a href="metrics.json">全 metrics</a> · <a href="footage/provenance.json">素材と変換の根拠</a></p>${cards}</main></html>`,
	);
	return results;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [
		sourcePath,
		outputDirectory,
		speechAudioPath,
		transcriptPath,
		fontPath,
	] = process.argv.slice(2);
	assert(
		sourcePath &&
			outputDirectory &&
			speechAudioPath &&
			transcriptPath &&
			fontPath,
		"Usage: evaluate-composition.ts original.mp4 output-directory jfk.wav transcript.json font.otf",
	);
	await evaluateComposition({
		sourcePath,
		outputDirectory,
		speechAudioPath,
		transcriptPath,
		fontPath,
		ffmpegPath: process.env.FFMPEG_PATH,
		ffprobePath: process.env.FFPROBE_PATH,
	});
}

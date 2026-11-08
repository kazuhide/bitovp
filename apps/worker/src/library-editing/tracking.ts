import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	getPreparedShotPartitionEntry,
	hashEditingEvidence,
	LOCAL_STORY_TRACKING_POLICY_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	type PreparedShotPartition,
	type PreparedShotPartitionEntry,
	preparedFrameForSourceAppearance,
	type SceneAnalysisDocument,
} from "@bitovp/core";
import {
	analysisBudget,
	analysisScratch,
	boundedInteger,
	MAX_ANALYSIS_DURATION_US,
	verifyAnalysisFile,
} from "./analysis-io";
import { MediaOperationError, runMediaProcess } from "./process";

export type TrackingBox = { x: number; y: number; w: number; h: number };
export type TrackingObservation = {
	sourceTimeUs: number;
	box: TrackingBox;
	confidence: number;
};
export type TrackingFallbackReason =
	| "NO_SEED"
	| "BEFORE_SEED"
	| "LOW_TEXTURE"
	| "LOST"
	| "AMBIGUOUS"
	| "INSUFFICIENT_SAMPLES"
	| "WORK_LIMIT";
type GrayTrackResult = {
	observations: TrackingObservation[];
	lostAtUs: number | null;
	reason?: TrackingFallbackReason;
	operations: number;
	gaps?: { fromUs: number; toUs: number; reason: "LOST" }[];
};
export type TrackingShot = {
	targetId?: string;
	sceneId: string;
	shotIndex: number;
	startUs: number;
	endUs: number;
	/** Prepared-file CFR30 indices. Supply both; endFrame is exclusive. */
	startFrame?: number;
	endFrame?: number;
	seed?: {
		sourceTimeUs: number;
		/** Keeps a canonical ceil(frame * 1e6 / 30) timestamp from being ceiled twice. */
		sourceFrame?: number;
		box?: TrackingBox;
		center?: { x: number; y: number };
	};
};
export type TrackingInput = {
	/** Opt-in recovery policy; legacy measurements/cache remain unchanged. */
	adaptiveRecovery?: boolean;
	sourcePath: string;
	mediaSha256: string;
	sourceWidth: number;
	sourceHeight: number;
	shots: TrackingShot[];
	ffmpegPath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};
export type LocalTrackingResult = {
	schemaVersion: 1;
	algorithm: typeof LOCAL_TRACKING_ALGORITHM_VERSION;
	frameClockVersion: typeof LOCAL_TRACKING_FRAME_CLOCK_VERSION;
	mediaSha256: string;
	cacheKey: string;
	sampleFps: 3;
	observations: (TrackingObservation & {
		sceneId: string;
		shotIndex: number;
	})[];
	/** Additional actual six-fps samples; baseline observations remain three-fps. */
	recoveryMeasurements?: (TrackingObservation & {
		sceneId: string;
		shotIndex: number;
	})[];
	fallbacks: {
		sceneId: string;
		shotIndex: number;
		fromUs: number;
		toUs: number;
		reason: TrackingFallbackReason;
	}[];
};
const MAX_OPERATIONS = 300_000_000;
const frameTimeUs = (frame: number) =>
	Number((BigInt(frame) * 1_000_000n + 29n) / 30n);
function frameAtSeconds(
	seconds: number,
	sourceStartUs: number,
	rounding: "CEIL" | "FLOOR",
) {
	if (!Number.isFinite(seconds) || seconds < 0)
		throw new RangeError("Invalid tracking source seconds");
	const origin = sourceStartUs / 1_000_000,
		frame = (seconds - origin) * 30,
		nearest = Math.round(frame),
		error =
			4 *
			Number.EPSILON *
			Math.max(1, Math.abs(seconds * 30), Math.abs(origin * 30));
	const result =
		Math.abs(frame - nearest) <= error
			? nearest
			: rounding === "CEIL"
				? Math.ceil(frame)
				: Math.floor(frame);
	if (!Number.isSafeInteger(result))
		throw new RangeError("Invalid tracking source frame");
	return result;
}

/** AISA times remain raw seconds until their one conversion to prepared CFR30.
 * A compiled generation window already owns its frame indices and bypasses us rounding.
 */
export function trackingShotFromAnalysis(input: {
	target?: { id: string; subjectIndexes: readonly number[] };
	sceneId: string;
	shotIndex: number;
	shot: SceneAnalysisDocument["scenes"][number]["shots"][number];
	sourceStartUs: number;
	frameWindow?: { startFrame: number; endFrame: number };
	/** Already bound to the prepared media by the caller; only factory-created clocks are admitted. */
	preparedPartition?: PreparedShotPartition;
}): TrackingShot | undefined {
	boundedInteger(input.sourceStartUs, 0, Number.MAX_SAFE_INTEGER);
	let entry: PreparedShotPartitionEntry | undefined;
	if (input.preparedPartition) {
		try {
			entry = getPreparedShotPartitionEntry(input.preparedPartition, input);
			if (
				!entry ||
				input.preparedPartition.timeMap.sourceStartUs !== input.sourceStartUs ||
				entry.sceneId.toLowerCase() !== input.sceneId.toLowerCase() ||
				entry.shotIndex !== input.shotIndex ||
				entry.rawStartInSeconds !== input.shot.startInSeconds ||
				entry.rawEndInSeconds !== input.shot.endInSeconds ||
				entry.shotHash !== hashEditingEvidence(input.shot)
			)
				throw new RangeError();
		} catch {
			throw new RangeError(
				"Tracking partition does not match its shot evidence",
			);
		}
	}
	const rawStart = frameAtSeconds(
			input.shot.startInSeconds,
			input.sourceStartUs,
			"CEIL",
		),
		rawEnd = frameAtSeconds(
			input.shot.endInSeconds,
			input.sourceStartUs,
			"FLOOR",
		),
		allowedStart = entry?.fromFrame ?? rawStart,
		allowedEnd = entry?.toFrame ?? rawEnd;
	let startFrame = input.frameWindow?.startFrame ?? allowedStart,
		endFrame = input.frameWindow?.endFrame ?? allowedEnd;
	if (!input.frameWindow && (startFrame < 0 || endFrame <= startFrame))
		return undefined;
	boundedInteger(startFrame, 0, 108_000);
	boundedInteger(endFrame, startFrame + 1, 108_000);
	if (startFrame < allowedStart || endFrame > allowedEnd)
		throw new RangeError(
			entry
				? "Tracking window exceeds its prepared partition"
				: "Tracking window exceeds its original shot",
		);
	if (entry) {
		startFrame = Math.max(startFrame, entry.certainFromFrame);
		endFrame = Math.min(endFrame, entry.certainToFrame);
		if (
			endFrame <= startFrame ||
			entry.fitBands.some(
				(band) => band.fromFrame < endFrame && band.toFrame > startFrame,
			)
		)
			return undefined;
	}
	if (
		input.target &&
		(!/^target-[a-f0-9]{64}$/.test(input.target.id) ||
			input.target.subjectIndexes.length < 1 ||
			input.target.subjectIndexes.length > 4 ||
			new Set(input.target.subjectIndexes).size !==
				input.target.subjectIndexes.length ||
			input.target.subjectIndexes.some(
				(index) =>
					!Number.isInteger(index) ||
					index < 0 ||
					index >= input.shot.mainSubjects.length,
			))
	)
		throw new RangeError("Invalid story tracking target");
	const singleSubject = input.shot.mainSubjects[0];
	const subjects = input.target
		? input.target.subjectIndexes.flatMap((index) => {
				const subject = input.shot.mainSubjects[index];
				return subject ? [subject] : [];
			})
		: input.shot.mainSubjects.length === 1 && singleSubject
			? [singleSubject]
			: [];
	let subject = subjects[0];
	if (
		input.target &&
		(!subjects.every((value) => !!value.box2d) ||
			new Set(subjects.map((value) => value.appearanceTimeInSeconds)).size !==
				1)
	)
		subject = undefined;
	if (subject && subjects.length > 1) {
		const boxes = subjects.flatMap((value) =>
			value.box2d ? [value.box2d] : [],
		);
		subject = {
			...subject,
			box2d: [
				Math.min(...boxes.map((box) => box[0])),
				Math.min(...boxes.map((box) => box[1])),
				Math.max(...boxes.map((box) => box[2])),
				Math.max(...boxes.map((box) => box[3])),
			],
		};
	}
	const appearanceFrame = subject
			? input.preparedPartition
				? preparedFrameForSourceAppearance(
						input.preparedPartition,
						input.shot.startInSeconds + subject.appearanceTimeInSeconds,
					)
				: frameAtSeconds(
						input.shot.startInSeconds + subject.appearanceTimeInSeconds,
						input.sourceStartUs,
						"CEIL",
					)
			: endFrame,
		// A new-clock seed remains the original observation. Do not move it out of
		// an uncertain band or into a later selected window just to start a track.
		seedFrame =
			entry || input.target
				? appearanceFrame
				: Math.max(startFrame, appearanceFrame),
		box = subject?.box2d;
	return {
		...(input.target ? { targetId: input.target.id } : {}),
		sceneId: input.sceneId,
		shotIndex: input.shotIndex,
		startFrame,
		endFrame,
		startUs: frameTimeUs(startFrame),
		endUs: frameTimeUs(endFrame),
		...(subject &&
		seedFrame >= startFrame &&
		seedFrame < endFrame &&
		!entry?.fitBands.some(
			(band) => seedFrame >= band.fromFrame && seedFrame < band.toFrame,
		)
			? {
					seed: {
						sourceFrame: seedFrame,
						sourceTimeUs: frameTimeUs(seedFrame),
						...(box
							? {
									box: {
										x: box[1] / 1000,
										y: box[0] / 1000,
										w: (box[3] - box[1]) / 1000,
										h: (box[2] - box[0]) / 1000,
									},
								}
							: {
									center: {
										x: subject.centerX / 100,
										y: subject.centerY / 100,
									},
								}),
					},
				}
			: {}),
	};
}
function validBox(box: TrackingBox) {
	return (
		[box.x, box.y, box.w, box.h].every(Number.isFinite) &&
		box.x >= 0 &&
		box.y >= 0 &&
		box.w > 0 &&
		box.h > 0 &&
		box.x + box.w <= 1 + 1e-9 &&
		box.y + box.h <= 1 + 1e-9
	);
}

/** Bounded multiscale NCC over actual decoded frames. The immutable seed
 * and a reverse match guard adaptive templates against gradual identity drift.
 * Formula: https://docs.opencv.org/4.13.0/df/dfb/group__imgproc__object.html
 */
export async function trackGrayFrames(input: {
	adaptiveRecovery?: boolean;
	frames: readonly Uint8Array[];
	width: number;
	height: number;
	seedBox: TrackingBox;
	sourceStartUs: number;
	sampleStepUs: number;
	sampleTimesUs?: readonly number[];
	searchRadius?: number;
	maxOperations?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<GrayTrackResult> {
	const width = boundedInteger(input.width, 8, 320),
		height = boundedInteger(input.height, 8, 320);
	boundedInteger(input.frames.length, 1, input.adaptiveRecovery ? 1120 : 560);
	boundedInteger(input.sourceStartUs, 0, Number.MAX_SAFE_INTEGER);
	boundedInteger(input.sampleStepUs, 1, 1_000_000);
	if (
		!validBox(input.seedBox) ||
		input.frames.some((frame) => frame.length !== width * height)
	)
		throw new RangeError("Invalid grayscale tracking input");
	if (
		input.sampleTimesUs &&
		(input.sampleTimesUs.length !== input.frames.length ||
			input.sampleTimesUs.some(
				(time, i) =>
					!Number.isSafeInteger(time) ||
					time < 0 ||
					(i > 0 && time <= (input.sampleTimesUs?.[i - 1] ?? Infinity)),
			))
	)
		throw new RangeError("Invalid sample times");
	const budget = analysisBudget(input.signal, input.timeoutMs ?? 180_000);
	budget.check();
	const timeAt = (i: number) =>
		input.sampleTimesUs?.[i] ?? input.sourceStartUs + i * input.sampleStepUs;
	const radius = boundedInteger(
			input.searchRadius ?? Math.max(8, Math.round(width * 0.08)),
			1,
			48,
		),
		maxOperations = boundedInteger(
			input.maxOperations ?? MAX_OPERATIONS,
			1,
			MAX_OPERATIONS,
		);
	const box = input.seedBox,
		initialW = Math.min(48, Math.round(box.w * width)),
		initialH = Math.min(48, Math.round(box.h * height));
	const failure = (reason: TrackingFallbackReason): GrayTrackResult => ({
		observations: [],
		lostAtUs: timeAt(0),
		reason,
		operations: 0,
	});
	if (initialW < 8 || initialH < 8) return failure("LOW_TEXTURE");
	type Region = { x: number; y: number; w: number; h: number };
	type Template = { values: Float64Array; variance: number };
	type Match = Region & { score: number };
	let previous: Region = {
		x: Math.round((box.x + box.w / 2) * width - initialW / 2),
		y: Math.round((box.y + box.h / 2) * height - initialH / 2),
		w: initialW,
		h: initialH,
	};
	const columns = Math.min(12, initialW),
		rows = Math.min(12, initialH),
		count = columns * rows;
	const valueAt = (frame: Uint8Array, x: number, y: number) => {
		const left = Math.floor(x),
			top = Math.floor(y),
			dx = x - left,
			dy = y - top;
		const pixel = (px: number, py: number) =>
			frame[
				Math.max(0, Math.min(height - 1, py)) * width +
					Math.max(0, Math.min(width - 1, px))
			] ?? 0;
		return (
			pixel(left, top) * (1 - dx) * (1 - dy) +
			pixel(left + 1, top) * dx * (1 - dy) +
			pixel(left, top + 1) * (1 - dx) * dy +
			pixel(left + 1, top + 1) * dx * dy
		);
	};
	const sample = (frame: Uint8Array, region: Region, gx: number, gy: number) =>
		valueAt(
			frame,
			region.x + (gx * (region.w - 1)) / (columns - 1),
			region.y + (gy * (region.h - 1)) / (rows - 1),
		);
	const templateAt = (frame: Uint8Array, region: Region): Template => {
		const values = new Float64Array(count);
		let sum = 0;
		for (let gy = 0; gy < rows; gy++)
			for (let gx = 0; gx < columns; gx++) {
				const value = sample(frame, region, gx, gy);
				values[gy * columns + gx] = value;
				sum += value;
			}
		const mean = sum / count;
		let variance = 0;
		for (let i = 0; i < values.length; i++) {
			const value = (values[i] ?? 0) - mean;
			values[i] = value;
			variance += value * value;
		}
		return { values, variance };
	};
	const first = input.frames[0];
	if (!first) throw new RangeError("Missing seed frame");
	const anchor = templateAt(first, previous);
	if (Math.sqrt(anchor.variance / count) < 8) return failure("LOW_TEXTURE");
	let adaptive = anchor,
		operations = 0,
		lostAtUs: number | null = null,
		reason: TrackingFallbackReason | undefined;
	const limit = Symbol("WORK_LIMIT");
	const scoreAt = (template: Template, frame: Uint8Array, region: Region) => {
		if (operations + count > maxOperations) throw limit;
		operations += count;
		let sum = 0,
			squared = 0,
			dot = 0;
		for (let gy = 0; gy < rows; gy++)
			for (let gx = 0; gx < columns; gx++) {
				const value = sample(frame, region, gx, gy);
				sum += value;
				squared += value * value;
				dot += (template.values[gy * columns + gx] ?? 0) * value;
			}
		const variance = squared - (sum * sum) / count;
		return variance < 1
			? -1
			: Math.max(
					-1,
					Math.min(1, dot / Math.sqrt(template.variance * variance)),
				);
	};
	const observedBox = (region: Region): TrackingBox => {
		const w = (box.w * region.w) / initialW,
			h = (box.h * region.h) / initialH;
		return {
			x: (region.x + region.w / 2) / width - w / 2,
			y: (region.y + region.h / 2) / height - h / 2,
			w,
			h,
		};
	};
	const search = (
		frame: Uint8Array,
		template: Template,
		around: Region,
		widths: readonly number[],
		searchRadius: number,
		requireBox: boolean,
	) => {
		let best: Match | undefined;
		const candidates: Match[] = [];
		for (const w of [...new Set(widths)]) {
			const h = Math.round((initialH * w) / initialW);
			if (
				w < Math.max(8, initialW / 2) ||
				w > Math.min(96, initialW * 2) ||
				h < 8 ||
				h > Math.min(96, initialH * 2) ||
				w > width ||
				h > height
			)
				continue;
			const left = Math.round(around.x + around.w / 2 - w / 2),
				top = Math.round(around.y + around.h / 2 - h / 2);
			for (
				let y = Math.max(0, top - searchRadius);
				y <= Math.min(height - h, top + searchRadius);
				y++
			) {
				budget.check();
				for (
					let x = Math.max(0, left - searchRadius);
					x <= Math.min(width - w, left + searchRadius);
					x++
				) {
					const region = { x, y, w, h };
					if (requireBox && !validBox(observedBox(region))) continue;
					const candidate = {
						...region,
						score: scoreAt(template, frame, region),
					};
					candidates.push(candidate);
					if (
						!best ||
						candidate.score > best.score + 1e-12 ||
						(Math.abs(candidate.score - best.score) <= 1e-12 &&
							Math.abs(w - around.w) < Math.abs(best.w - around.w))
					)
						best = candidate;
				}
			}
		}
		return { best, candidates };
	};
	const observations: TrackingObservation[] = [
		{ sourceTimeUs: timeAt(0), box: { ...box }, confidence: 1 },
	];
	const gaps: NonNullable<GrayTrackResult["gaps"]> = [];
	const lost = Symbol("LOST"),
		ambiguous = Symbol("AMBIGUOUS");
	let previousObservedIndex = 0,
		pendingLoss: number | undefined,
		recoveryMisses = 0;
	for (let index = 1; index < input.frames.length; index++) {
		await setImmediate();
		budget.check();
		const frame = input.frames[index],
			previousFrame = input.frames[previousObservedIndex];
		if (!frame || !previousFrame) break;
		try {
			let { best, candidates } = search(
				frame,
				adaptive,
				previous,
				[-4, -2, -1, 0, 1, 2, 4].map((delta) => previous.w + delta),
				radius,
				true,
			);
			if (
				input.adaptiveRecovery &&
				(pendingLoss !== undefined || !best || best.score < 0.85)
			) {
				// Wider, pixel-dense NCC against the original seed, never a new identity.
				const expanded = search(
					frame,
					anchor,
					previous,
					[-4, -2, -1, 0, 1, 2, 4].map((delta) => previous.w + delta),
					Math.min(48, Math.max(radius * 3, radius + 24)),
					true,
				);
				best = expanded.best;
				candidates = expanded.candidates;
			}
			if (!best || best.score < 0.78) {
				throw lost;
			}
			const separation = Math.max(3, Math.round(Math.min(best.w, best.h) / 3));
			const other = candidates.reduce(
				(max, point) =>
					Math.hypot(
						point.x + point.w / 2 - best.x - best.w / 2,
						point.y + point.h / 2 - best.y - best.h / 2,
					) >= separation
						? Math.max(max, point.score)
						: max,
				-1,
			);
			if (best.score - other < 0.035) {
				throw ambiguous;
			}
			const anchorScore = scoreAt(anchor, frame, best);
			if (anchorScore < 0.78) {
				throw lost;
			}
			const current = templateAt(frame, best);
			const reverse = search(
				previousFrame,
				current,
				previous,
				[previous.w - 1, previous.w, previous.w + 1],
				2,
				false,
			).best;
			if (
				!reverse ||
				reverse.score < 0.78 ||
				Math.hypot(
					reverse.x + reverse.w / 2 - previous.x - previous.w / 2,
					reverse.y + reverse.h / 2 - previous.y - previous.h / 2,
				) > 1.5 ||
				Math.abs(reverse.w - previous.w) > 1
			) {
				throw lost;
			}
			const confidence = Math.min(best.score, anchorScore, reverse.score);
			observations.push({
				sourceTimeUs: timeAt(index),
				box: observedBox(best),
				confidence,
			});
			if (pendingLoss !== undefined) {
				gaps.push({ fromUs: pendingLoss, toUs: timeAt(index), reason: "LOST" });
				pendingLoss = undefined;
				recoveryMisses = 0;
			}
			previous = best;
			previousObservedIndex = index;
			// Seed compatibility stays mandatory even after adaptation. A strong local
			// match alone cannot slowly replace the originally selected subject.
			if (
				confidence >= 0.9 &&
				best.score - other >= 0.05 &&
				Math.sqrt(current.variance / count) >= 8
			)
				adaptive = current;
		} catch (error) {
			if (error !== limit && error !== lost && error !== ambiguous) throw error;
			if (error === lost && input.adaptiveRecovery) {
				pendingLoss ??= timeAt(previousObservedIndex);
				if (++recoveryMisses <= 3 && index < input.frames.length - 1) continue;
			}
			reason =
				error === limit
					? "WORK_LIMIT"
					: error === ambiguous
						? "AMBIGUOUS"
						: "LOST";
			lostAtUs = pendingLoss ?? timeAt(index);
			break;
		}
	}
	if (observations.length < 2)
		return {
			observations: [],
			lostAtUs: timeAt(0),
			reason: reason ?? "INSUFFICIENT_SAMPLES",
			operations,
		};
	return {
		observations,
		lostAtUs,
		...(reason ? { reason } : {}),
		...(gaps.length ? { gaps } : {}),
		operations,
	};
}

export function trackingCacheKey(
	input: Pick<
		TrackingInput,
		| "mediaSha256"
		| "sourceWidth"
		| "sourceHeight"
		| "shots"
		| "adaptiveRecovery"
	>,
) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: LOCAL_TRACKING_ALGORITHM_VERSION,
				frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
				...(input.adaptiveRecovery
					? { recoveryPolicy: LOCAL_STORY_TRACKING_POLICY_VERSION }
					: {}),
				...(input.adaptiveRecovery
					? {
							refinementFps: 6,
							maximumRefinementPasses: 1,
							maximumRecoveryMisses: 3,
						}
					: {}),
				scaleSteps: [-4, -2, -1, 0, 1, 2, 4],
				maxSeedScale: 2,
				adaptiveMinConfidence: 0.9,
				immutableSeedMinCorrelation: 0.78,
				sampleFps: 3,
				maxDimension: 320,
				minCorrelation: 0.78,
				minPeakMargin: 0.035,
				mediaSha256: input.mediaSha256,
				sourceWidth: input.sourceWidth,
				sourceHeight: input.sourceHeight,
				shots: input.shots.map((shot) => ({
					...(shot.targetId ? { targetId: shot.targetId } : {}),
					sceneId: shot.sceneId,
					shotIndex: shot.shotIndex,
					startUs: shot.startUs,
					endUs: shot.endUs,
					startFrame: shot.startFrame ?? null,
					endFrame: shot.endFrame ?? null,
					seed: shot.seed
						? {
								sourceTimeUs: shot.seed.sourceTimeUs,
								sourceFrame: shot.seed.sourceFrame ?? null,
								box: shot.seed.box
									? {
											x: shot.seed.box.x,
											y: shot.seed.box.y,
											w: shot.seed.box.w,
											h: shot.seed.box.h,
										}
									: null,
								center: shot.seed.center
									? { x: shot.seed.center.x, y: shot.seed.center.y }
									: null,
							}
						: null,
				})),
			}),
		)
		.digest("hex");
}

/** Extract bounded real CFR samples. Input is already normalized, displayed 30fps media. */
export async function trackShotSubjects(
	input: TrackingInput,
): Promise<LocalTrackingResult> {
	boundedInteger(input.sourceWidth, 8, 8192);
	boundedInteger(input.sourceHeight, 8, 8192);
	boundedInteger(input.shots.length, 1, 20);
	let totalUs = 0;
	for (const shot of input.shots) {
		boundedInteger(shot.startUs, 0, 3_600_000_000);
		boundedInteger(shot.endUs, shot.startUs + 1, 3_600_000_000);
		const explicitWindow =
			shot.startFrame !== undefined || shot.endFrame !== undefined;
		if (explicitWindow) {
			const start = boundedInteger(shot.startFrame ?? NaN, 0, 108_000),
				end = boundedInteger(shot.endFrame ?? NaN, start + 1, 108_000);
			if (
				frameTimeUs(start) !== shot.startUs ||
				frameTimeUs(end) !== shot.endUs
			)
				throw new RangeError(
					"Tracking frame window conflicts with its microseconds",
				);
		}
		boundedInteger(shot.shotIndex, 0, 4999);
		if (!shot.sceneId || shot.sceneId.length > 128)
			throw new RangeError("Invalid shot identity");
		totalUs += shot.endUs - shot.startUs;
		if (shot.seed) {
			boundedInteger(shot.seed.sourceTimeUs, shot.startUs, shot.endUs - 1);
			if (shot.seed.sourceFrame !== undefined) {
				if (!explicitWindow)
					throw new RangeError(
						"An explicit tracking seed requires a frame window",
					);
				boundedInteger(
					shot.seed.sourceFrame,
					shot.startFrame ?? 0,
					(shot.endFrame ?? 0) - 1,
				);
				if (frameTimeUs(shot.seed.sourceFrame) !== shot.seed.sourceTimeUs)
					throw new RangeError(
						"Tracking seed frame conflicts with its microseconds",
					);
			}
			if (
				shot.seed.box
					? !validBox(shot.seed.box)
					: !shot.seed.center ||
						![shot.seed.center.x, shot.seed.center.y].every(
							(value) => Number.isFinite(value) && value >= 0 && value <= 1,
						)
			)
				throw new RangeError("Invalid tracking seed");
		}
	}
	boundedInteger(totalUs, 1, MAX_ANALYSIS_DURATION_US);
	const budget = analysisBudget(input.signal, input.timeoutMs ?? 180_000);
	await verifyAnalysisFile(
		input.sourcePath,
		input.mediaSha256,
		"SOURCE_CHANGED",
		budget,
	);
	const scale = Math.min(
		1,
		320 / Math.max(input.sourceWidth, input.sourceHeight),
	);
	const width = Math.max(8, Math.floor((input.sourceWidth * scale) / 2) * 2),
		height = Math.max(8, Math.floor((input.sourceHeight * scale) / 2) * 2);
	const result: LocalTrackingResult = {
		schemaVersion: 1,
		algorithm: LOCAL_TRACKING_ALGORITHM_VERSION,
		frameClockVersion: LOCAL_TRACKING_FRAME_CLOCK_VERSION,
		mediaSha256: input.mediaSha256,
		cacheKey: trackingCacheKey(input),
		sampleFps: 3,
		observations: [],
		fallbacks: [],
	};
	const directory = await analysisScratch("bitovp-tracking-");
	let remainingOperations = MAX_OPERATIONS;
	try {
		for (const [index, shot] of input.shots.entries()) {
			budget.check();
			const fallback = (fromUs: number, reason: TrackingFallbackReason) => {
				if (fromUs < shot.endUs)
					result.fallbacks.push({
						sceneId: shot.sceneId,
						shotIndex: shot.shotIndex,
						fromUs,
						toUs: shot.endUs,
						reason,
					});
			};
			if (!shot.seed) {
				fallback(shot.startUs, "NO_SEED");
				continue;
			}
			const seed = shot.seed;
			const seedFrame =
					seed.sourceFrame ?? Math.ceil((seed.sourceTimeUs * 30) / 1_000_000),
				endFrame = shot.endFrame ?? Math.floor((shot.endUs * 30) / 1_000_000);
			const sourceTime = frameTimeUs;
			const startUs = sourceTime(seedFrame);
			if (startUs > shot.startUs)
				result.fallbacks.push({
					sceneId: shot.sceneId,
					shotIndex: shot.shotIndex,
					fromUs: shot.startUs,
					toUs: Math.min(startUs, shot.endUs),
					reason: "BEFORE_SEED",
				});
			const count = Math.ceil((endFrame - seedFrame) / 10);
			if (count < 2) {
				fallback(startUs, "INSUFFICIENT_SAMPLES");
				continue;
			}
			if (remainingOperations < 1) {
				fallback(startUs, "WORK_LIMIT");
				continue;
			}
			const decodeAndTrack = async (stepFrames: 10 | 5) => {
				const count = Math.ceil((endFrame - seedFrame) / stepFrames),
					path = join(directory, `shot-${index}-${stepFrames}.gray`),
					bytes = count * width * height;
				// https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect
				await runMediaProcess(
					input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
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
						(seedFrame / 30).toFixed(9),
						"-i",
						input.sourcePath,
						"-t",
						((endFrame - seedFrame) / 30).toFixed(9),
						"-an",
						"-vf",
						`scale=${width}:${height}:flags=area,format=gray,select=not(mod(n\\,${stepFrames}))`,
						"-fps_mode",
						"vfr",
						"-frames:v",
						String(count),
						"-f",
						"rawvideo",
						"-pix_fmt",
						"gray",
						"-fs",
						String(bytes),
						"-y",
						path,
					],
					{
						signal: input.signal,
						timeoutMs: budget.remaining(),
						maxOutputBytes: 1024 * 1024,
					},
				);
				const size = (await stat(path)).size;
				if (!size || size > bytes || size % (width * height))
					throw new MediaOperationError("TRACKING_FRAMES_INVALID");
				const raw = await readFile(path),
					frames = Array.from(
						{ length: raw.length / (width * height) },
						(_, n) =>
							raw.subarray(n * width * height, (n + 1) * width * height),
					);
				const center = seed.center;
				const seedBox = seed.box ?? {
					x: Math.max(0, Math.min(0.85, (center?.x ?? 0.5) - 0.075)),
					y: Math.max(0, Math.min(0.8, (center?.y ?? 0.5) - 0.1)),
					w: 0.15,
					h: 0.2,
				};
				const tracked = await trackGrayFrames({
					adaptiveRecovery: input.adaptiveRecovery,
					frames,
					width,
					height,
					seedBox,
					sourceStartUs: startUs,
					sampleStepUs: stepFrames === 10 ? 333_333 : 166_666,
					sampleTimesUs: frames.map((_, n) =>
						sourceTime(seedFrame + n * stepFrames),
					),
					maxOperations: remainingOperations,
					signal: input.signal,
					timeoutMs: budget.remaining(),
				});
				remainingOperations -= tracked.operations;
				await rm(path, { force: true });
				return tracked;
			};
			let tracked = await decodeAndTrack(10),
				dense = false;
			const fastMotion = tracked.observations.some((point, i, all) => {
				const previous = all[i - 1];
				return (
					previous &&
					Math.hypot(
						point.box.x + point.box.w / 2 - previous.box.x - previous.box.w / 2,
						point.box.y + point.box.h / 2 - previous.box.y - previous.box.h / 2,
					) /
						((point.sourceTimeUs - previous.sourceTimeUs) / 1_000_000) >
						0.25
				);
			});
			if (
				input.adaptiveRecovery &&
				remainingOperations > 0 &&
				(tracked.reason === "LOST" || tracked.gaps?.length || fastMotion)
			) {
				budget.check();
				tracked = await decodeAndTrack(5);
				dense = true;
			}
			for (const observation of tracked.observations) {
				const isRecoveryMeasurement =
					dense &&
					(Number((BigInt(observation.sourceTimeUs) * 30n) / 1_000_000n) -
						seedFrame) %
						10 !==
						0;
				let observations = result.observations;
				if (isRecoveryMeasurement) {
					result.recoveryMeasurements ??= [];
					observations = result.recoveryMeasurements;
				}
				observations.push({
					...observation,
					sceneId: shot.sceneId,
					shotIndex: shot.shotIndex,
				});
			}
			for (const gap of tracked.gaps ?? [])
				result.fallbacks.push({
					sceneId: shot.sceneId,
					shotIndex: shot.shotIndex,
					...gap,
				});
			if (tracked.reason) fallback(tracked.lostAtUs ?? startUs, tracked.reason);
		}
		return result;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

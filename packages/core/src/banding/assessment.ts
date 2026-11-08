import {
	type BandingAssessment,
	type BandingFrame,
	type BandingPooled,
	type BandingSeverity,
	type BandingThresholds,
	bandingFrameSchema,
	bandingPooledSchema,
} from "./types";

const TIME_EPSILON = 1e-7;

/** Full-frame evidence only. Chart samples must never determine a QC verdict. */
export function validateBandingFrames(frames: BandingFrame[]): void {
	if (frames.length === 0) throw new Error("Banding measurement has no frames");
	let previous: BandingFrame | undefined;
	for (const [index, frame] of frames.entries()) {
		bandingFrameSchema.parse(frame);
		if (frame.frameNum !== index)
			throw new Error("Banding frame coverage is incomplete");
		if (
			previous &&
			(frame.timestampSeconds <= previous.timestampSeconds ||
				frame.timestampSeconds + TIME_EPSILON <
					previous.timestampSeconds + previous.durationSeconds)
		)
			throw new Error(
				"Banding presentation intervals overlap or are unordered",
			);
		previous = frame;
	}
}

export function computeBandingPooled(frames: BandingFrame[]): BandingPooled {
	validateBandingFrames(frames);
	let mean = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = 0;
	let durationSeconds = 0;
	for (const [index, frame] of frames.entries()) {
		mean += (frame.cambi - mean) / (index + 1);
		min = Math.min(min, frame.cambi);
		max = Math.max(max, frame.cambi);
		durationSeconds += frame.durationSeconds;
	}
	return bandingPooledSchema.parse({
		mean,
		min,
		max,
		frameCount: frames.length,
		durationSeconds,
	});
}

function severityOf(
	value: number,
	thresholds: BandingThresholds,
): BandingSeverity {
	if (
		thresholds.failureThreshold !== undefined &&
		value > thresholds.failureThreshold
	)
		return "FAIL";
	if (
		thresholds.warningThreshold !== undefined &&
		value > thresholds.warningThreshold
	)
		return "WARN";
	return "PASS";
}

export function assessBandingFrames(
	frames: BandingFrame[],
	thresholds: BandingThresholds = {},
): BandingAssessment {
	validateBandingFrames(frames);
	for (const value of [
		thresholds.warningThreshold,
		thresholds.failureThreshold,
	]) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0))
			throw new Error("Banding thresholds must be finite and nonnegative");
	}
	const result: BandingAssessment = {
		severity: "PASS",
		ranges: [],
		affectedSeconds: 0,
		warningSeconds: 0,
		failureSeconds: 0,
	};
	for (const frame of frames) {
		const severity = severityOf(frame.cambi, thresholds);
		if (severity === "PASS") continue;
		if (severity === "FAIL") {
			result.severity = "FAIL";
			result.failureSeconds += frame.durationSeconds;
		} else {
			if (result.severity === "PASS") result.severity = "WARN";
			result.warningSeconds += frame.durationSeconds;
		}
		result.affectedSeconds += frame.durationSeconds;
		const previous = result.ranges.at(-1);
		if (
			previous &&
			previous.severity === severity &&
			previous.endFrame + 1 === frame.frameNum &&
			Math.abs(previous.endSeconds - frame.timestampSeconds) <= TIME_EPSILON
		) {
			previous.endFrame = frame.frameNum;
			previous.endSeconds = frame.timestampSeconds + frame.durationSeconds;
			previous.peak = Math.max(previous.peak, frame.cambi);
		} else {
			result.ranges.push({
				startSeconds: frame.timestampSeconds,
				endSeconds: frame.timestampSeconds + frame.durationSeconds,
				startFrame: frame.frameNum,
				endFrame: frame.frameNum,
				peak: frame.cambi,
				severity,
			});
		}
	}
	return result;
}

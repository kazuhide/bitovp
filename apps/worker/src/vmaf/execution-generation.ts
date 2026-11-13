import {
	NATIVE_OFFICIAL_REVISION,
	VMAF_EXPERIMENTAL_GPU_DECODE_SCORING_VERSION,
	VMAF_EXPERIMENTAL_GPU_SCORING_VERSION,
	VMAF_OWNED_CUDA_SCORING_VERSION,
	VMAF_OWNED_VULKAN_SCORING_VERSION,
	VMAF_RETIRED_OWNED_CUDA_SCORING_VERSION,
	VMAF_RETIRED_OWNED_VULKAN_SCORING_VERSION,
	VMAF_SCORING_VERSION,
} from "@bitovp/core";

/** What a row keeps of the scoring method with which it started, so that a
 * later attempt by a worker with another method is refused. `comparison` names
 * what the scorer compares: the pictures of libvmaf through FFmpeg, at the
 * reference's bit depth. Rows of the retired generations hold `bitDepth: 10`
 * in its place. */
export function ownedScoringSnapshot(backend: "cuda" | "vulkan") {
	return {
		backend,
		implementation: "bitovp-owned",
		comparison: "ffmpeg-libvmaf",
		officialRevision: NATIVE_OFFICIAL_REVISION,
	};
}
export function localScoringGeneration(options: {
	scoringVersion: number;
	isCloud: boolean;
	scoringBackend?: string;
	decodeBackend?: "cpu" | "auto" | "cuda";
	storedScoring?: unknown;
}) {
	const backend = options.scoringBackend ?? "cpu";
	if (!["cpu", "cuda", "vulkan"].includes(backend))
		throw new Error(
			"VMAFx scoring is retired; select cuda or vulkan and create a new measurement",
		);
	const experimental = [
		VMAF_EXPERIMENTAL_GPU_SCORING_VERSION,
		VMAF_EXPERIMENTAL_GPU_DECODE_SCORING_VERSION,
		// Rows of the retired generations are never continued: their numbers
		// are not those of the generations below.
		VMAF_RETIRED_OWNED_CUDA_SCORING_VERSION,
		VMAF_RETIRED_OWNED_VULKAN_SCORING_VERSION,
		VMAF_OWNED_CUDA_SCORING_VERSION,
		VMAF_OWNED_VULKAN_SCORING_VERSION,
	];
	const changed = () => {
		throw new Error(
			"Experimental GPU configuration changed; create a new measurement",
		);
	};
	if (options.scoringVersion === VMAF_EXPERIMENTAL_GPU_SCORING_VERSION)
		changed();
	if (options.isCloud) {
		if (experimental.includes(options.scoringVersion)) changed();
		return undefined;
	}
	const generation =
		backend === "cuda"
			? VMAF_OWNED_CUDA_SCORING_VERSION
			: backend === "vulkan"
				? VMAF_OWNED_VULKAN_SCORING_VERSION
				: options.decodeBackend && options.decodeBackend !== "cpu"
					? VMAF_EXPERIMENTAL_GPU_DECODE_SCORING_VERSION
					: undefined;
	if (
		experimental.includes(options.scoringVersion) &&
		options.scoringVersion !== generation
	)
		changed();
	if (backend !== "cpu") {
		if ((options.decodeBackend ?? "cpu") !== "cpu")
			throw new Error("Owned GPU scoring currently requires CPU decoding");
		if (
			options.scoringVersion !== VMAF_SCORING_VERSION &&
			options.scoringVersion !== generation
		)
			changed();
		const expected = ownedScoringSnapshot(backend as "cuda" | "vulkan");
		const saved = options.storedScoring;
		if (saved !== undefined || options.scoringVersion === generation) {
			if (
				!saved ||
				typeof saved !== "object" ||
				Array.isArray(saved) ||
				Object.entries(expected).some(
					([key, value]) => (saved as Record<string, unknown>)[key] !== value,
				)
			)
				throw new Error(
					"The saved scoring method differs from this worker; create a new measurement",
				);
		}
	} else if (options.storedScoring !== undefined) {
		throw new Error(
			"The saved scoring method differs from this worker; create a new measurement",
		);
	}
	return generation;
}

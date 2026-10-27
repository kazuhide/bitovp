import type { ExpectedMuxing } from "@bitovp/core";
import type { PerTitleDeliveryBinding } from "./per-title-delivery";

type ResultCheck = {
	id: string;
	verdict: "PASS" | "FAIL" | "SKIP";
	detail: string;
};

/** Keep generated media facts separate from the template's independent constraints. */
export function perTitleMediaExpectation(binding: PerTitleDeliveryBinding): {
	muxing: ExpectedMuxing;
	checks: ResultCheck[];
} {
	const identity = `pertitle-delivery:${binding.id}`;
	const checkPrefix = `pertitle:result:${binding.id}`;
	const planned = binding.expectedMuxing.video;
	const actual = binding.actualVideo;
	const mode = binding.expectedMuxing.perTitleStreamMode;
	const fixedResolution =
		mode !== undefined
			? mode !== "PER_TITLE_TEMPLATE"
			: binding.expectedMuxing.perTitleMode === "FIXED";
	const checks: ResultCheck[] = [];
	if (planned) {
		if (
			mode === undefined &&
			!fixedResolution &&
			(planned.height !== null || planned.width !== undefined)
		) {
			checks.push({
				id: `${checkPrefix}:stream-mode`,
				verdict: "SKIP",
				detail:
					"UNVERIFIED template geometry requirements: the legacy expectation does not retain the Per-title stream mode",
			});
		}
		for (const axis of ["width", "height"] as const) {
			const generated = actual?.[axis];
			const required = planned[axis];
			if (generated === undefined) {
				checks.push({
					id: `${checkPrefix}:result-${axis}`,
					verdict: "SKIP",
					detail: `UNVERIFIED captured RESULT ${axis}: no positive finite ${axis} was captured; template hints and output paths cannot supply it`,
				});
			} else if (
				fixedResolution &&
				required !== null &&
				required !== undefined
			) {
				checks.push({
					id: `${checkPrefix}:configured-${axis}`,
					verdict: generated === required ? "PASS" : "FAIL",
					detail: `configured fixed ${axis} ${required} — captured RESULT ${generated}`,
				});
			}
		}
		if (planned.fps !== undefined && actual?.fps !== undefined) {
			checks.push({
				id: `${checkPrefix}:configured-fps`,
				verdict: Math.abs(planned.fps - actual.fps) < 0.02 ? "PASS" : "FAIL",
				detail: `configured fps ${planned.fps} — captured RESULT ${actual.fps}`,
			});
		}
	}
	return {
		checks,
		muxing: {
			...binding.expectedMuxing,
			muxingKey: identity,
			renditionKey: identity,
			outputKey: binding.outputKey,
			dir: {
				pattern: binding.actual.resolvedPath,
				prefix: binding.actual.resolvedPath,
				templated: false,
			},
			...(planned
				? {
						video: {
							...planned,
							height:
								actual?.height ?? (fixedResolution ? planned.height : null),
							width:
								actual?.width ?? (fixedResolution ? planned.width : undefined),
							bitrate: actual?.bitrate ?? null,
							fps: actual?.fps ?? planned.fps,
						},
					}
				: {}),
			perTitle: false,
			perTitleMode: undefined,
			perTitleStreamMode: undefined,
			viaDrmKeys: binding.expectedDrm ? [`${identity}:drm`] : undefined,
		},
	};
}

/**
 * Which muxing leg a DASH manifest lists — spelled ONCE.
 *
 * The compiler's static selection and the validator's `PLAN_DASH_VIDEO_UNSELECTED`
 * rule used to carry hand-duplicated copies of this predicate (review-323 S2).
 * They agreed on the day they were written; a shared function is what keeps them
 * agreeing after the next change to either. The codec family is still decided by
 * the caller — this answers only "is this the leg the manifest declared".
 */
type Leg = { kind: string; manifestType?: string };

/** ON_DEMAND lists DASH_ON_DEMAND-typed MP4s; segmented profiles list the pinned leg. */
function onDemandLeg(muxing: Leg): boolean {
	return muxing.kind === "MP4" && muxing.manifestType === "DASH_ON_DEMAND";
}

export function dashVideoLegSelected(
	muxing: Leg,
	manifest: { videoMuxingKind?: string },
	onDemand: boolean,
): boolean {
	if (onDemand) {
		return onDemandLeg(muxing);
	}
	// The manifest's DECLARED video leg — FMP4 by default, WEBM when the plan
	// says so. This used to be a literal `"FMP4"` first conjunct, which made
	// `videoMuxingKind: "WEBM"` select nothing: the schema admitted it, the
	// encoder produced four WebM ladders, and the MPD carried audio only.
	return (
		(muxing.kind === "FMP4" ||
			muxing.kind === "CMAF" ||
			muxing.kind === "WEBM") &&
		muxing.kind === (manifest.videoMuxingKind ?? "FMP4")
	);
}

export function dashAudioLegSelected(
	muxing: Leg,
	manifest: { audioMuxingKind?: string },
	onDemand: boolean,
): boolean {
	if (onDemand) {
		return onDemandLeg(muxing);
	}
	return muxing.kind === (manifest.audioMuxingKind ?? "FMP4");
}

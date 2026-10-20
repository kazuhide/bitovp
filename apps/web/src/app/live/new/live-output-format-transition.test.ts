import { describe, expect, it } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import {
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
	withMslStreamFormat,
} from "./build-live-plan";

describe("multiple manifests during an MSL format change", () => {
	it.each([
		"HLS",
		"DASH",
		"CMAF",
	] as const)("retains additional manifest settings and disabled rows when selecting %s", (format) => {
		const state: LiveWizardState = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		state.output.kind = "AKAMAI_MSL";
		state.output.mslStreamFormat = "HLS";
		state.manifests.additionalHls = [
			{
				...state.manifests.hls,
				key: "alternate-hls",
				manifestName: "alternate.m3u8",
				audioLanguage: "ja",
				destination: {
					outputKey: "mirror-1",
					path: "alternate",
					acl: "PRIVATE",
				},
			},
			{ ...state.manifests.hls, key: "disabled-hls", enabled: false },
		];
		state.manifests.additionalDash = [
			{
				...state.manifests.dash,
				key: "alternate-dash",
				manifestName: "alternate.mpd",
				minimumUpdatePeriod: 2,
			},
		];
		const original = structuredClone(state.manifests);
		const next = withMslStreamFormat(state, format);
		expect(next.manifests.additionalHls).toEqual(original.additionalHls);
		expect(next.manifests.additionalDash).toEqual(original.additionalDash);
		expect(next.manifests.hls.enabled).toBe(format !== "DASH");
		expect(next.manifests.dash.enabled).toBe(format !== "HLS");
		const restored = mergeWizardDraft(
			DEFAULT_LIVE_WIZARD_STATE,
			projectWizardDraft("live", next),
			"live",
		);
		expect(restored.manifests.additionalHls).toEqual(original.additionalHls);
		expect(restored.manifests.additionalDash).toEqual(original.additionalDash);
	});
});

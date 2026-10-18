import { compileLiveChannel, liveChannelPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { evaluateLiveWizardState } from "./live-plan-preview";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

function state() {
	const s = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	s.name = "Mirror channel";
	s.start.streamKey = "disposabletest";
	s.output = {
		...s.output,
		credentialId: "00000000-0000-4000-8000-000000000001",
		bucket: "media",
		basePath: "live/test",
	};
	return s;
}

describe("Live storage mirror authoring", () => {
	it.each([
		"media",
		" media ",
	])("rejects the same primary bucket %s before submission", (bucket) => {
		const s = state();
		s.mirror = { ...s.output, bucket };
		expect(evaluateLiveWizardState(s).ok).toBe(false);
	});
	it.each([
		"AKAMAI_MSL",
		"SFTP",
		"AKAMAI_NETSTORAGE",
	] as const)("refuses unsupported form mirror %s without discarding it", (kind) => {
		const s = state();
		s.mirror = { ...s.output, kind };
		expect(evaluateLiveWizardState(s).ok).toBe(false);
		expect(s.mirror.kind).toBe(kind);
	});
	it("keeps default off and preserves a different-bucket mirror roundtrip", () => {
		const s = state();
		expect(buildLiveChannelPlan(s).deliveryMirrors).toBeUndefined();
		s.mirror = { ...s.output, bucket: "mirror" };
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
		expect(evaluateLiveWizardState(s).ok).toBe(true);
		expect(tryImportLiveChannelIntoWizard(p).ok).toBe(true);
		expect(p.deliveryMirrors).toEqual([{ outputKey: "mirror-1" }]);
	});
	it.each([
		undefined,
		null,
		"",
	])("refuses missing bucket %s without throwing", (bucket) => {
		const s = state();
		s.mirror = { ...s.output, bucket } as LiveWizardState["output"];
		expect(evaluateLiveWizardState(s).ok).toBe(false);
	});
	it("rejects a missing or mismatched credential from the loaded catalogue", () => {
		const s = state();
		s.mirror = { ...s.output, bucket: "mirror" };
		expect(evaluateLiveWizardState(s, undefined, []).ok).toBe(false);
		expect(
			evaluateLiveWizardState(s, undefined, [
				{ id: s.mirror.credentialId, provider: "DRM_CENC" },
			]).ok,
		).toBe(false);
		expect(
			evaluateLiveWizardState(s, undefined, [
				{ id: s.mirror.credentialId, provider: "AWS_S3" },
			]).ok,
		).toBe(true);
	});
	it("inherits primary segment PUBLIC_READ into mirror but not private MP4", () => {
		const s = state();
		s.output.publicRead = true;
		s.mirror = {
			...s.output,
			kind: "GENERIC_S3",
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "aos",
		};
		s.archive = {
			muxing: {
				key: "archive",
				kind: "MP4",
				streamKey: "v720",
				additionalStreamKeys: ["a128"],
				filename: "archive.mp4",
				destination: { outputKey: "mirror-1", path: "live/test/archive" },
			},
		};
		const ops = compileLiveChannel(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(s)),
		);
		const segment = ops.find((op) => op.kind === "CREATE_MUXING_FMP4");
		expect(segment?.refs).toMatchObject({
			outputId: "output:origin",
			mirrorOutputIds: ["output:mirror-1"],
		});
		expect(JSON.stringify(segment?.payload)).toContain("PUBLIC_READ");
		const archive = ops.find((op) => op.kind === "CREATE_MUXING_MP4");
		expect(archive?.refs).toMatchObject({ outputId: "output:mirror-1" });
		expect(archive?.refs).not.toHaveProperty("mirrorOutputIds");
		expect(JSON.stringify(archive?.payload)).not.toContain("PUBLIC_READ");
		s.mirror = undefined;
		const missing = evaluateLiveWizardState(s);
		expect(missing.ok && missing.issues.some((i) => i.level === "error")).toBe(
			true,
		);
	});
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCredentialSchema } from "../credentials/schemas";
import { redactSecrets } from "../crypto/redact";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

const credentialId = "00000000-0000-4000-8000-000000000001";
function originPlan() {
	const raw = JSON.parse(
		readFileSync(
			new URL("./__fixtures__/live-rtmp-simple.plan.json", import.meta.url),
			"utf8",
		),
	);
	raw.outputs = [
		{
			key: "origin",
			kind: "LIVE_MEDIA_INGEST",
			credentialId,
			scte35Passthrough: true,
		},
	];
	raw.liveManifests = [];
	return liveChannelPlanSchema.parse(raw);
}
describe("Live Media Ingest delivery", () => {
	it("allows fMP4 delivery without Bitmovin manifests and compiles vault references only", () => {
		const plan = originPlan();
		expect(
			validateLiveChannel(plan).filter((x) => x.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan);
		expect(
			ops.find((x) => x.kind === "CREATE_OUTPUT_LIVE_MEDIA_INGEST"),
		).toMatchObject({ payload: { credentialId, scte35Passthrough: true } });
		expect(
			ops.some(
				(x) =>
					x.kind === "CREATE_MANIFEST_HLS" || x.kind === "CREATE_MANIFEST_DASH",
			),
		).toBe(false);
		expect(JSON.stringify(ops)).not.toContain("publishingPoint");
	});
	it("retains the manifest requirement for object storage", () => {
		const plan = originPlan();
		expect(
			liveChannelPlanSchema.safeParse({
				...plan,
				outputs: [{ key: "origin", kind: "S3", credentialId, bucket: "test" }],
			}).success,
		).toBe(false);
	});
	it("refuses TS delivery to a Live Media Ingest output", () => {
		const plan = originPlan();
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("Fixture has no muxing");
		muxing.kind = "TS";
		expect(
			validateLiveChannel(plan).some(
				(x) => x.code === "LIVE_MEDIA_INGEST_FMP4_ONLY",
			),
		).toBe(true);
	});
	it("accepts HTTP and HTTPS publishing URLs, rejects userinfo and masks endpoint", () => {
		for (const url of [
			"http://origin.example/channel.isml",
			"https://origin.example/channel.isml?token=secret",
		])
			expect(
				createCredentialSchema.safeParse({
					provider: "LIVE_MEDIA_INGEST",
					label: "Origin",
					secret: { publishingPoint: url },
				}).success,
			).toBe(true);
		expect(
			createCredentialSchema.safeParse({
				provider: "LIVE_MEDIA_INGEST",
				label: "Origin",
				secret: { publishingPoint: "https://user:pass@origin.example/live" },
			}).success,
		).toBe(false);
		expect(redactSecrets({ publishingPoint: "private" })).toEqual({
			publishingPoint: "[REDACTED]",
		});
	});
});

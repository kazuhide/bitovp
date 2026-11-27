import { expect, it } from "vitest";
import { createNativeCodecSchema } from "./native-codec-configurations";

const h262 = {
	codec: "h262",
	name: "Broadcast",
	bitmovinAccountId: "00000000-0000-4000-8000-000000000001",
	scopeVersion: "00000000-0000-4000-8000-000000000002",
};

it("requires an explicit supported profile and positive target bitrate for H.262", () => {
	const profile = { profile: "MPEG2_422" };
	const rate = { bitrate: 50000000 };
	expect(
		createNativeCodecSchema.safeParse({ ...h262, ...profile, ...rate }).success,
	).toBe(true);
	for (const fields of [
		profile,
		rate,
		{ ...profile, bitrate: 0 },
		{ ...rate, profile: "MAIN" },
	]) {
		expect(
			createNativeCodecSchema.safeParse({ ...h262, ...fields }).success,
		).toBe(false);
	}
});

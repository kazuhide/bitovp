import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import { compileExpectedLiveArtefacts } from "./expected-live";

function fixture() {
	return JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"../live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
}
const credential = "00000000-0000-4000-8000-000000000002";
const otherCredential = "00000000-0000-4000-8000-000000000003";

it.each([
	["S3", "S3", true, true],
	["GCS", "GCS_SERVICE_ACCOUNT", true, true],
	["GENERIC_S3", "GENERIC_S3", false, true],
	["GENERIC_S3", "GENERIC_S3", true, false],
	["S3", "GCS", false, false],
] as const)("keeps canonical %s/%s storage identity with different credentials=%s", (primaryKind, aliasKind, differentCredential, aliases) => {
	const raw = fixture();
	raw.outputs = [
		{
			key: "origin",
			kind: primaryKind,
			bucket: "shared-name",
			credentialId: credential,
		},
		{
			key: "alias",
			kind: aliasKind,
			bucket: "shared-name",
			credentialId: differentCredential ? otherCredential : credential,
		},
	];
	const expected = compileExpectedLiveArtefacts(
		liveChannelPlanSchema.parse(raw),
	);
	const manifest = expected.manifests[0];
	if (!manifest) throw new Error("Missing manifest fixture");
	expect(expected.muxings.every((m) => m.outputKey === "origin")).toBe(true);
	expect(
		expected.muxings.every((m) =>
			(m.namingOnlyOutputKeys ?? []).includes("alias"),
		),
	).toBe(aliases);
	expect(
		(expected.namingOnlyFiles ?? []).some(
			(f) =>
				f.outputKey === "alias" &&
				f.key === `${manifest.dir.prefix}${manifest.files[0]}`,
		),
	).toBe(aliases);
});

it("does not join unrelated primaries through a common mirror", () => {
	const raw = fixture();
	raw.outputs.push(
		{ ...raw.outputs[0], key: "unrelated", bucket: "unrelated-bucket" },
		{ ...raw.outputs[0], key: "shared-mirror", bucket: "shared-mirror-bucket" },
	);
	raw.deliveryMirrors = [{ outputKey: "shared-mirror" }];
	const expected = compileExpectedLiveArtefacts(
		liveChannelPlanSchema.parse(raw),
	);
	for (const muxing of expected.muxings)
		expect(muxing.namingOnlyOutputKeys).toEqual(["shared-mirror"]);
	expect(
		expected.namingOnlyFiles?.some((f) => f.outputKey === "unrelated"),
	).toBe(false);
	expect(
		expected.namingOnlyFiles?.some((f) => f.outputKey === "shared-mirror"),
	).toBe(true);
});

it("carries literal master, child, init and archive files through every effective site", () => {
	const raw = fixture();
	const folder = "output/literal/%number%/./media";
	raw.outputs.push(
		{ ...raw.outputs[0], key: "alias" },
		{ ...raw.outputs[0], key: "mirror", bucket: "mirror-bucket" },
	);
	raw.deliveryMirrors = [{ outputKey: "mirror" }];
	for (const manifest of raw.liveManifests)
		manifest.destination = { outputKey: "alias", path: folder };
	raw.muxings[0].destination.path = folder;
	raw.muxings[0].initSegmentName = "init_%number%_{rand_chars:8}.mp4";
	raw.muxings.push({
		key: "archive",
		kind: "MP4",
		streamKey: "v1080",
		filename: "archive_%number%_{rand_chars:8}.mp4",
		destination: { outputKey: "alias", path: folder },
	});
	const expected = compileExpectedLiveArtefacts(
		liveChannelPlanSchema.parse(raw),
	);
	const files = expected.namingOnlyFiles ?? [];
	for (const outputKey of ["origin", "mirror"])
		for (const filename of [
			"stream.m3u8",
			"stream.mpd",
			"video_4500000.m3u8",
			"audio_128000.m3u8",
			"archive_%number%_{rand_chars:8}.mp4",
		])
			expect(files).toContainEqual({
				outputKey,
				key: `output/literal/%number%/media/${filename}`,
			});
	for (const outputKey of ["alias", "mirror"])
		expect(files).toContainEqual({
			outputKey,
			key: "output/literal/%number%/media/init_%number%_{rand_chars:8}.mp4",
		});
	expect(files.some((file) => /archive_1_Ab12Cd34/.test(file.key))).toBe(false);
});

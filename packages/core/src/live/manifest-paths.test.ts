import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { liveManifestPathIssues } from "./manifest-paths";
import { liveChannelPlanSchema } from "./schema";

function fixture() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		),
	);
}

describe("Live physical output file reservations", () => {
	it("reserves an archive on the storage mirror that the compiler also writes", () => {
		const plan = fixture();
		const origin = plan.outputs[0];
		const manifest = plan.liveManifests.find((entry) => entry.kind === "HLS");
		if (origin?.kind !== "S3" || !manifest)
			throw new Error("Missing storage and manifest fixtures");
		plan.outputs.push(
			{ ...origin, key: "recording", bucket: "recording-storage" },
			{ ...origin, key: "mirror", bucket: "shared-storage" },
		);
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		plan.muxings.push({
			key: "archive",
			kind: "MP4",
			streamKey: "v1080",
			additionalStreamKeys: ["a128"],
			filename: manifest.manifestName,
			destination: {
				outputKey: "recording",
				path: manifest.destination.path,
			},
		});
		const archive = compileLiveChannel(plan).find(
			(operation) => operation.step === "muxing:archive",
		);
		expect(archive?.refs).toMatchObject({
			outputId: "output:recording",
			mirrorOutputIds: ["output:mirror"],
		});
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				path: "muxings[4].destination",
			}),
		);
		const recording = plan.muxings.at(-1);
		if (!recording?.destination) throw new Error("Missing archive fixture");
		recording.destination.path += "/archive";
		expect(liveManifestPathIssues(plan)).toEqual([]);
	});

	it("permits the same writer through an output alias and a mirror", () => {
		const plan = fixture();
		const origin = plan.outputs[0];
		if (!origin) throw new Error("Missing output fixture");
		plan.outputs.push({ ...origin, key: "alias" });
		plan.deliveryMirrors = [{ outputKey: "alias" }];
		expect(liveManifestPathIssues(plan)).toEqual([]);
	});
});

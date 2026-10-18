import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";

const fixture = () =>
	liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-akamai-msl-storage.plan.json"),
				"utf8",
			),
		),
	);

describe("Live manifest logical root versus per-output wire root", () => {
	it.each([
		"origin",
		"mirror-1",
	])("uses / only for Generic S3 with %s primary, preserving logical relative paths and ACL", (primary) => {
		const plan = fixture();
		const mirror = primary === "origin" ? "mirror-1" : "origin";
		plan.deliveryMirrors = [{ outputKey: mirror }];
		for (const manifest of plan.liveManifests)
			manifest.destination = {
				outputKey: primary,
				path: "",
				acl: "PUBLIC_READ",
			};
		const before = structuredClone(plan);
		const ops = compileLiveChannel(plan);
		const manifests = ops.filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		);
		expect(manifests.map((op) => op.kind)).toEqual([
			"CREATE_MANIFEST_HLS",
			"CREATE_MANIFEST_DASH",
		]);
		for (const manifest of manifests) {
			expect(manifest.payload).toMatchObject({
				outputPath: primary === "origin" ? "/" : "",
				mirrorOutputPaths: [mirror === "origin" ? "/" : ""],
				acl: "PUBLIC_READ",
			});
			expect(manifest.refs.mirrorOutputIds).toEqual([`output:${mirror}`]);
		}
		const hls = manifests[0];
		expect(
			ops
				.filter((op) => op.refs.manifestId === hls?.step)
				.map((op) => op.payload.segmentPath),
		).toEqual(plan.muxings.map((muxing) => muxing.destination?.path));
		expect(
			ops
				.filter((op) => op.kind === "CREATE_MUXING_FMP4")
				.map((op) => op.payload.outputPath),
		).toEqual(plan.muxings.map((muxing) => muxing.destination?.path));
		expect(plan).toEqual(before);
	});

	it.each([
		"folder",
		"/folder/",
		"/",
		" ",
	])("preserves nonempty Generic S3 path %j", (path) => {
		const plan = fixture();
		plan.deliveryMirrors = [];
		for (const manifest of plan.liveManifests) manifest.destination.path = path;
		for (const op of compileLiveChannel(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		)) {
			expect(op.payload.outputPath).toBe(path);
			expect(op.payload).not.toHaveProperty("mirrorOutputPaths");
		}
	});

	it("does not change other storage roots or add redundant mirror paths", () => {
		const plan = fixture();
		plan.deliveryMirrors = [];
		for (const manifest of plan.liveManifests) manifest.destination.path = "";
		for (const op of compileLiveChannel(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		)) {
			expect(op.payload.outputPath).toBe("/");
			expect(op.payload).not.toHaveProperty("mirrorOutputPaths");
		}
		const storage = plan.outputs[0];
		if (storage?.kind !== "GENERIC_S3")
			throw new Error("missing fixture Generic S3 output");
		plan.outputs[0] = { ...storage, kind: "S3" };
		for (const op of compileLiveChannel(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		))
			expect(op.payload.outputPath).toBe("");
	});

	it("leaves VOD Generic S3 logical empty unchanged", () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						__dirname,
						"../plan/__fixtures__/generic-s3-akamai-io.plan.json",
					),
					"utf8",
				),
			),
		);
		for (const manifest of plan.manifests) manifest.destination.path = "";
		const manifests = compilePlan(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.payload.outputPath).toBe("");
	});
});

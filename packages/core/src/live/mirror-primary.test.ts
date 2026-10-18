import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

const folder = "output/live-akamai-msl-storage";
const fixture = () =>
	liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-akamai-msl-storage.plan.json"),
				"utf8",
			),
		),
	);

describe("Live destinations exclude only their own global mirror", () => {
	it("omits a self-only mirror for every muxing and HLS/DASH manifest", () => {
		const plan = fixture();
		plan.outputs = plan.outputs.filter((output) => output.key === "origin");
		plan.deliveryMirrors = [{ outputKey: "origin" }];
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan).filter((op) => op.refs.outputId);
		expect(compileExpectedLiveArtefacts(plan)).not.toHaveProperty("mirrors");
		expect(ops).toHaveLength(6);
		for (const op of ops) {
			expect(op.refs.outputId).toBe("output:origin");
			expect(op.refs).not.toHaveProperty("mirrorOutputIds");
			expect(op.payload).not.toHaveProperty("mirrorOutputPaths");
		}
	});

	it.each([
		0, 1, 2,
	])("keeps other mirror order and wire-path alignment with self at position %i", (selfAt) => {
		const plan = fixture();
		const storage = plan.outputs[0];
		if (!storage) throw new Error("missing fixture storage output");
		plan.outputs.push({ ...storage, key: "storage-two" });
		plan.deliveryMirrors = [
			{ outputKey: "mirror-1" },
			{ outputKey: "storage-two" },
		];
		plan.deliveryMirrors.splice(selfAt, 0, { outputKey: "origin" });
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan).filter((op) => op.refs.outputId);
		expect(ops).toHaveLength(6);
		for (const op of ops) {
			expect(op.refs.mirrorOutputIds).toEqual([
				"output:mirror-1",
				"output:storage-two",
			]);
			if (op.kind.startsWith("CREATE_MANIFEST_")) {
				expect(op.payload.outputPath).toBe(folder);
				expect(op.payload.mirrorOutputPaths).toEqual([`/${folder}/`, folder]);
			} else {
				expect(op.payload).not.toHaveProperty("mirrorOutputPaths");
			}
		}
	});

	it("keeps the MSL event-root manifest and adds a storage-only manifest over the same mirrored 3V1A muxings", () => {
		const plan = fixture();
		for (const manifest of plan.liveManifests)
			manifest.destination = { outputKey: "mirror-1", path: "" };
		const root = plan.liveManifests[0];
		if (!root) throw new Error("missing fixture HLS manifest");
		root.destination = { outputKey: "mirror-1", path: "" };
		root.manifestName = "unique-msl-root.m3u8";
		plan.liveManifests.push({
			...root,
			key: "storage-hls",
			manifestName: "unique-storage.m3u8",
			destination: { outputKey: "origin", path: folder },
		});
		for (const muxing of plan.muxings) {
			if (!muxing.destination) throw new Error("missing fixture destination");
			muxing.destination.outputKey = "mirror-1";
		}
		plan.deliveryMirrors = [{ outputKey: "origin" }];
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan);
		const expected = compileExpectedLiveArtefacts(plan);
		expect(expected.mirrors).toEqual([
			{ outputKey: "origin", kind: "GENERIC_S3" },
		]);
		expect(expected.mslEdgeOutputs).toEqual([
			{ outputKey: "mirror-1", role: "PRIMARY" },
		]);
		expect(
			expected.manifests
				.filter((manifest) => manifest.kind === "HLS")
				.map((manifest) => [
					manifest.outputKey,
					manifest.mediaPlaylists.length,
				]),
		).toEqual([
			["mirror-1", 4],
			["origin", 4],
		]);
		const manifests = ops.filter((op) => op.kind === "CREATE_MANIFEST_HLS");
		expect(manifests).toHaveLength(2);
		expect(manifests[0]).toMatchObject({
			payload: { outputPath: "" },
			refs: { outputId: "output:mirror-1", mirrorOutputIds: ["output:origin"] },
		});
		expect(manifests[1]).toMatchObject({
			payload: { outputPath: folder },
			refs: { outputId: "output:origin" },
		});
		expect(manifests[1]?.refs).not.toHaveProperty("mirrorOutputIds");
		expect(manifests[1]?.payload).not.toHaveProperty("mirrorOutputPaths");
		const muxings = ops.filter((op) => op.kind === "CREATE_MUXING_FMP4");
		expect(muxings).toHaveLength(4);
		for (const muxing of muxings)
			expect(muxing.refs).toMatchObject({
				outputId: "output:mirror-1",
				mirrorOutputIds: ["output:origin"],
			});
		for (const [index, manifest] of manifests.entries()) {
			const children = ops.filter((op) => op.refs.manifestId === manifest.step);
			expect(children).toHaveLength(4);
			expect(children.map((op) => op.payload.segmentPath)).toEqual(
				["video/1080p", "video/720p", "video/360p", "audio/128000"].map(
					(path) => (index === 0 ? `${folder}/${path}` : path),
				),
			);
		}
		expect(
			ops.find((op) => op.kind === "START_LIVE_ENCODING")?.refs
				.liveHlsManifestIds,
		).toEqual(manifests.map((op) => op.step));
	});

	it.each([
		"MSL4",
		"MSL5",
	] as const)("refuses %s primary/global-mirror mixed roles before compilation", (mslVersion) => {
		const plan = fixture();
		for (const manifest of plan.liveManifests)
			manifest.destination = { outputKey: "mirror-1", path: "" };
		const msl = plan.outputs.find((output) => output.kind === "AKAMAI_MSL");
		if (msl?.kind !== "AKAMAI_MSL") throw new Error("missing fixture MSL");
		msl.mslVersion = mslVersion;
		if (mslVersion === "MSL5") {
			for (const muxing of plan.muxings) {
				if (muxing.kind === "MP4") throw new Error("fixture must be segmented");
				muxing.segmentNaming = "$RepresentationID$_$Number$.m4s";
				if (muxing.kind === "FMP4")
					muxing.initSegmentName = "$RepresentationID$_init.mp4";
			}
		}
		const root = plan.liveManifests[0];
		if (!root) throw new Error("missing fixture HLS manifest");
		plan.liveManifests.push({
			...root,
			key: "storage-hls",
			destination: { outputKey: "origin", path: folder },
		});
		expect(
			validateLiveChannel(plan)
				.filter((issue) => issue.level === "error")
				.every((issue) => issue.code === "PLAN_DUPLICATE_KEY"),
		).toBe(true);
		expect(validateLiveChannel(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_DUPLICATE_KEY",
				level: "error",
				path: "liveManifests.0.destination.outputKey",
			}),
		);
	});

	it.each([
		"SFTP",
		"AKAMAI_NETSTORAGE",
	] as const)("retains overlap refusal for delivery-only %s", (kind) => {
		const plan = fixture();
		plan.outputs = [
			{
				key: "origin",
				kind,
				name: "Delivery-only output",
				credentialId: "00000000-0000-4000-8000-000000000003",
			},
		];
		plan.deliveryMirrors = [{ outputKey: "origin" }];
		expect(validateLiveChannel(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_DUPLICATE_KEY",
				level: "error",
				path: "muxings.0.destination.outputKey",
			}),
		);
	});

	it("preserves accepted wrapped MSL paths without normalizing storage key aliases", () => {
		const plan = fixture();
		for (const manifest of plan.liveManifests)
			manifest.destination = { outputKey: "mirror-1", path: `/${folder}/` };
		for (const muxing of plan.muxings) {
			if (!muxing.destination) throw new Error("missing fixture destination");
			muxing.destination.path = `/${muxing.destination.path}`;
			muxing.destination.outputKey = "mirror-1";
		}
		plan.deliveryMirrors = [{ outputKey: "origin" }];
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(plan);
		for (const manifest of ops.filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		)) {
			expect(manifest.payload.outputPath).toBe(`/${folder}/`);
			expect(manifest.payload).not.toHaveProperty("mirrorOutputPaths");
			expect(manifest.refs.mirrorOutputIds).toEqual(["output:origin"]);
		}
		const hls = ops.filter(
			(op) =>
				op.kind === "CREATE_HLS_STREAM_INFO" ||
				op.kind === "CREATE_HLS_AUDIO_MEDIA",
		);
		expect(hls.map((op) => op.payload.segmentPath)).toEqual([
			"video/1080p",
			"video/720p",
			"video/360p",
			"audio/128000",
		]);
	});
});

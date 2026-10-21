import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { addLiveManifest, addLiveMirror } from "./live-output-actions";
import { liveOutputReferenced } from "./live-output-model";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";
import { liveMirrorProblem } from "./mirror-model";

function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("Missing multi-output fixture value");
	return value;
}

function state(): LiveWizardState {
	const output = {
		...DEFAULT_LIVE_WIZARD_STATE.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "sample-output",
		basePath: "live/test",
		name: "Primary",
	};
	return {
		...DEFAULT_LIVE_WIZARD_STATE,
		name: "Multiple live outputs",
		output,
		mirror: {
			...output,
			bucket: "mirror-one",
			basePath: "",
			name: "First mirror",
		},
		additionalMirrors: [
			{
				key: "east",
				output: {
					...output,
					bucket: "mirror-two",
					basePath: "",
					name: "East mirror",
				},
			},
			{
				key: "west",
				output: {
					...output,
					bucket: "mirror-three",
					basePath: "",
					name: "West mirror",
				},
			},
		],
		manifests: {
			hls: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.hls, enabled: true },
			dash: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.dash, enabled: true },
			additionalHls: [
				{
					...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
					enabled: true,
					key: "french",
					name: "French HLS",
					manifestName: "fr.m3u8",
					audioLanguage: "fr",
					destination: {
						outputKey: "origin",
						path: "live/test/fr",
						acl: "PRIVATE",
					},
				},
				{
					...DEFAULT_LIVE_WIZARD_STATE.manifests.hls,
					enabled: true,
					key: "german",
					manifestName: "de.m3u8",
					audioLanguage: "de",
					destination: { outputKey: "origin", path: "live/test/de" },
				},
			],
			additionalDash: [
				{
					...DEFAULT_LIVE_WIZARD_STATE.manifests.dash,
					enabled: true,
					key: "dash-extra",
					name: "Alternate DASH",
					manifestName: "alternate.mpd",
					minimumUpdatePeriod: 2,
					destination: {
						outputKey: "origin",
						path: "live/test/dash",
						acl: "PRIVATE",
					},
				},
			],
		},
	};
}

describe("multiple Live output authoring", () => {
	it("points default additional HLS and DASH directories back to the shared ladder", () => {
		let value = state();
		value.videos = [
			...value.videos,
			{
				...required(value.videos[0]),
				height: 360,
				bitrate: 500_000,
				container: "CMAF",
				extras: { key: "v360" },
			},
		];
		value = { ...value, ...addLiveManifest(value, "HLS") };
		value = { ...value, ...addLiveManifest(value, "DASH") };
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(value));
		const operations = compileLiveChannel(plan);
		const hls = operations.filter(
			(operation) => operation.refs.manifestId === "manifest:hls-2",
		);
		expect(
			hls
				.filter((operation) => operation.kind === "CREATE_HLS_STREAM_INFO")
				.map((operation) => operation.payload.segmentPath),
		).toEqual(["../video/720p"]);
		expect(
			hls
				.filter((operation) => operation.kind === "CREATE_HLS_AUDIO_MEDIA")
				.map((operation) => operation.payload.segmentPath),
		).toEqual(["../audio/128000"]);
		const dash = operations.filter(
			(operation) =>
				operation.refs.manifestId === "manifest:dash-2" &&
				operation.kind.startsWith("CREATE_DASH_REPRESENTATION_"),
		);
		expect(
			dash.map((operation) => [operation.kind, operation.payload.segmentPath]),
		).toEqual([
			["CREATE_DASH_REPRESENTATION_FMP4", "../video/720p"],
			["CREATE_DASH_REPRESENTATION_CMAF", "../video/360p"],
			["CREATE_DASH_REPRESENTATION_FMP4", "../audio/128000"],
		]);
		for (const operation of [...hls, ...dash]) {
			if (typeof operation.payload.segmentPath !== "string") continue;
			const manifest = plan.liveManifests.find(
				(entry) => `manifest:${entry.key}` === operation.refs.manifestId,
			);
			const muxing = plan.muxings.find(
				(entry) => `muxing:${entry.key}` === operation.refs.muxingId,
			);
			if (!manifest || !muxing?.destination)
				throw new Error("Missing compiled destination");
			expect(
				new URL(
					`${operation.payload.segmentPath}/seg.m4s`,
					`https://delivery.example/published/${manifest.destination.path}/stream.m3u8`,
				).href,
			).toBe(
				`https://delivery.example/published/${muxing.destination.path}/seg.m4s`,
			);
		}
	});
	it("keeps a video playlist override through multi-output drafts, import and every HLS operation", () => {
		const original = state();
		original.videos = original.videos.map((video, index) =>
			index === 0
				? {
						...video,
						extras: { ...video.extras, hlsVariantUri: "main-video.m3u8" },
					}
				: video,
		);
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(original));
		const imported = tryImportLiveChannelIntoWizard(plan);
		if (!imported.ok) throw new Error(imported.reasonKey);
		const restored = mergeWizardDraft(
			DEFAULT_LIVE_WIZARD_STATE,
			projectWizardDraft("live", imported.state),
			"live",
		);
		expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(restored))).toEqual(
			plan,
		);
		const variants = compileLiveChannel(plan).filter(
			(operation) =>
				operation.kind === "CREATE_HLS_STREAM_INFO" &&
				operation.payload.uri === "main-video.m3u8",
		);
		expect(variants.map((operation) => operation.step.split(":")[1])).toEqual([
			"hls",
			"french",
			"german",
		]);
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
	it("checks URI tokens and all mirrored namespaces for an additional HLS manifest", () => {
		const original = state();
		const additional = original.manifests.additionalHls?.[0];
		if (!additional) throw new Error("Missing additional HLS fixture");
		additional.manifestName = "main-video.m3u8";
		original.videos = original.videos.map((video, index) =>
			index === 0
				? {
						...video,
						extras: { ...video.extras, hlsVariantUri: "main-video.m3u8" },
					}
				: video,
		);
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(original));
		expect(validateLiveChannel(plan).map((issue) => issue.code)).toContain(
			"LIVE_OUTPUT_NAMESPACE_COLLISION",
		);
		expect(validateLiveChannel(plan).map((issue) => issue.code)).toContain(
			"LIVE_HLS_URI_COLLISION",
		);
		required(plan.renditions[0]).hlsVariantUri = "main-{group}.m3u8";
		expect(validateLiveChannel(plan).map((issue) => issue.code)).toContain(
			"LIVE_HLS_VIDEO_URI_PATTERN",
		);
	});
	it("restores and clears every additional resource through the allowlisted browser draft", () => {
		const original = state();
		original.outputOrder = ["origin", "west", "mirror-1", "east"];
		original.manifestOrder = ["hls", "french", "dash", "german", "dash-extra"];
		const restored = mergeWizardDraft(
			DEFAULT_LIVE_WIZARD_STATE,
			projectWizardDraft("live", original),
			"live",
		);
		expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(restored))).toEqual(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(original)),
		);
		const cleared = mergeWizardDraft(
			restored,
			projectWizardDraft("live", DEFAULT_LIVE_WIZARD_STATE),
			"live",
		);
		expect(cleared.additionalMirrors).toBeUndefined();
		expect(cleared.manifests.additionalHls).toBeUndefined();
		expect(cleared.manifests.additionalDash).toBeUndefined();
	});
	it("emits every mirror and manifest without changing their destination ACLs", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		expect(plan.outputs.map((output) => output.key)).toEqual([
			"origin",
			"mirror-1",
			"east",
			"west",
		]);
		expect(plan.deliveryMirrors?.map((mirror) => mirror.outputKey)).toEqual([
			"mirror-1",
			"east",
			"west",
		]);
		expect(plan.liveManifests.map((manifest) => manifest.key)).toEqual([
			"hls",
			"dash",
			"french",
			"german",
			"dash-extra",
		]);
		expect(
			plan.liveManifests.find((manifest) => manifest.key === "french"),
		).toMatchObject({
			name: "French HLS",
			destination: { path: "live/test/fr", acl: "PRIVATE" },
		});
		expect(
			plan.liveManifests.find((manifest) => manifest.key === "german")
				?.destination,
		).not.toHaveProperty("acl");
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});
	it("preserves imported array order, stable identities, names and PRIVATE versus omitted ACL", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		plan.outputs = [
			required(plan.outputs[3]),
			required(plan.outputs[0]),
			required(plan.outputs[1]),
			required(plan.outputs[2]),
		];
		plan.liveManifests = [
			required(plan.liveManifests[4]),
			required(plan.liveManifests[2]),
			required(plan.liveManifests[1]),
			required(plan.liveManifests[3]),
			required(plan.liveManifests[0]),
		];
		expect(
			liveChannelPlanSchema.parse(
				buildLiveChannelPlan(planToLiveWizardState(plan)),
			),
		).toEqual(plan);
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error(imported.reasonKey);
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(plan);
	});
	it("passes all mirror references to delivery operations and all manifests to Live start", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		const ops = compileLiveChannel(plan);
		const manifests = ops.filter(
			(op) =>
				op.kind === "CREATE_MANIFEST_HLS" || op.kind === "CREATE_MANIFEST_DASH",
		);
		expect(manifests).toHaveLength(5);
		for (const manifest of manifests)
			expect(manifest.refs.mirrorOutputIds).toEqual([
				"output:mirror-1",
				"output:east",
				"output:west",
			]);
		const start = ops.find((op) => op.kind === "START_LIVE_ENCODING");
		expect(start).toBeDefined();
		expect(JSON.stringify(start)).toContain("manifest:french");
		expect(JSON.stringify(start)).toContain("manifest:dash-extra");
	});
	it("refuses a later mirror that duplicates an existing storage destination", () => {
		const next = state();
		required(next.additionalMirrors?.[1]).output = {
			...required(next.additionalMirrors?.[0]).output,
		};
		expect(liveMirrorProblem(next)).toBe("liveMirror.sameDestination");
	});
	it("blocks masters and derived HLS playlists that would overwrite another manifest", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		const first = required(plan.liveManifests[0]);
		plan.liveManifests.push({
			...first,
			key: "collision",
			manifestName: "another.m3u8",
		});
		expect(validateLiveChannel(plan)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				level: "error",
			}),
		);
	});
	it("reserves media init files and the archive writes sent to delivery mirrors", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		plan.outputs.push({
			...required(plan.outputs[0]),
			key: "recording",
			kind: "S3",
			bucket: "recordings",
		});
		plan.muxings.push({
			key: "archive",
			kind: "MP4",
			streamKey: "v720",
			additionalStreamKeys: ["a128"],
			filename: "stream.m3u8",
			destination: { outputKey: "recording", path: "live/test" },
		});
		expect(
			validateLiveChannel(plan).filter(
				(issue) => issue.code === "LIVE_OUTPUT_NAMESPACE_COLLISION",
			),
		).toHaveLength(3);
		const archive = plan.muxings.at(-1);
		if (archive?.kind !== "MP4") throw new Error("Missing archive fixture");
		archive.filename = "archive.mp4";
		expect(
			validateLiveChannel(plan).filter(
				(issue) => issue.code === "LIVE_OUTPUT_NAMESPACE_COLLISION",
			),
		).toEqual([]);
		const first = required(plan.muxings[0]);
		if (first.kind !== "FMP4" || !first.destination)
			throw new Error("Missing media init fixture");
		required(plan.liveManifests[0]).manifestName = first.initSegmentName;
		required(plan.liveManifests[0]).destination = first.destination;
		expect(validateLiveChannel(plan)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				level: "error",
			}),
		);
	});
	it("reserves a CMAF init filename only when its name is statically known", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		const first = required(plan.muxings[0]);
		if (first.kind !== "FMP4" || !first.destination)
			throw new Error("Missing CMAF init fixture");
		plan.muxings[0] = { ...first, kind: "CMAF" };
		const manifest = plan.liveManifests.find((entry) => entry.kind === "DASH");
		if (!manifest) throw new Error("Missing DASH fixture");
		manifest.manifestName = first.initSegmentName;
		manifest.destination = first.destination;
		const collisions = () =>
			validateLiveChannel(plan).filter(
				(issue) => issue.code === "LIVE_OUTPUT_NAMESPACE_COLLISION",
			);
		expect(collisions()).toHaveLength(4);
		plan.muxings[0] = {
			...first,
			kind: "CMAF",
			initSegmentNameTemplate: "different-{rand_chars:8}.mp4",
		};
		expect(collisions()).toEqual([]);
	});
	it("allocates stable unused identities and folders after deletion", () => {
		let next = state();
		next = { ...next, ...addLiveManifest(next, "HLS"), ...addLiveMirror(next) };
		const added = next.manifests.additionalHls?.at(-1);
		expect(added?.key).toBe("hls-2");
		expect(added?.destination?.path).toBe("live/test/hls-2");
		const mirror = next.additionalMirrors?.at(-1);
		if (!mirror) throw new Error("Missing added mirror");
		mirror.output = { ...next.output, bucket: "mirror-four", basePath: "" };
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(next));
		const imported = tryImportLiveChannelIntoWizard(plan);
		if (!imported.ok) throw new Error(imported.reasonKey);
		next = imported.state;
		next.manifests.additionalHls = next.manifests.additionalHls?.filter(
			(entry) => entry.key !== "hls-2",
		);
		next = { ...next, ...addLiveManifest(next, "HLS") };
		expect(next.manifests.additionalHls?.at(-1)?.key).toBe("hls-3");
	});
	it("keeps explicit false and reports references before a mirror is removed", () => {
		const next = state();
		const additional = required(next.manifests.additionalHls?.[0]);
		additional.insertProgramDateTimeExplicit = true;
		required(additional.destination).outputKey = "east";
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(next));
		expect(
			plan.liveManifests.find((entry) => entry.key === "french"),
		).toHaveProperty("insertProgramDateTime", false);
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		expect(liveOutputReferenced(next, "east")).toBe(true);
		expect(liveOutputReferenced(next, "west")).toBe(false);
	});
	it("reserves identities and folders while an additional manifest is disabled", () => {
		let next = state();
		next = { ...next, ...addLiveManifest(next, "HLS") };
		const first = next.manifests.additionalHls?.at(-1);
		if (!first) throw new Error("Missing added HLS fixture");
		first.enabled = false;
		next = { ...next, ...addLiveManifest(next, "HLS") };
		const second = next.manifests.additionalHls?.at(-1);
		expect(second?.key).toBe("hls-3");
		expect(second?.destination?.path).not.toBe(first.destination?.path);
	});
});

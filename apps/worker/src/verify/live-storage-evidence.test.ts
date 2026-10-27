import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { expect, it } from "vitest";
import type { LiveCleanupSeal } from "./live-cleanup-seal";
import { assembleLiveEvidence } from "./live-evidence-assembly";
import { listLiveOutputObjects } from "./live-storage-list";
import { sampleLiveStorageObjects } from "./live-storage-sample";

it.each([
	"healthy",
	"missing",
	"conflict",
] as const)("collects nested encrypted storage through the runner's recursive listing (%s)", async (mode) => {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
	plan.muxings = plan.muxings.map((m) => {
		if (m.kind !== "FMP4") throw new Error("Missing fMP4 fixture");
		return {
			...m,
			segmentNaming: "media/segment_%number%.m4s",
			initSegmentName: "headers/init.mp4",
			destination: { outputKey: "origin", path: `out/${m.key}` },
		};
	});
	plan.drm = plan.muxings.map((m) => ({
		key: `${m.key}-protected`,
		kind: "FAIRPLAY" as const,
		muxingKey: m.key,
		credentialId: "00000000-0000-4000-8000-000000000003",
		iv: "a".repeat(32),
		uri: "skd://synthetic",
		destination: { outputKey: "origin", path: `out/${m.key}/encrypted` },
	}));
	plan.liveManifests = plan.liveManifests
		.filter((m) => m.kind === "HLS")
		.map((m) => ({
			...m,
			drmKind: "FAIRPLAY",
			destination: { outputKey: "origin", path: "out" },
		}));
	const expected = compileExpectedLiveArtefacts(plan);
	const channel = {
		channelId: "channel-test",
		liveChannelRunId: "run-test",
		providerEncodingId: "encoding-test",
		providerStreamIds: Object.fromEntries(
			plan.renditions.map((r) => [r.key, `stream-${r.key}`]),
		),
		providerOutputIds: { origin: "output-test" },
	};
	const ok = { established: true, detail: "synthetic terminal observation" };
	const cleanup: LiveCleanupSeal = {
		...channel,
		productStopProjection: ok,
		providerTerminal: ok,
		localTerminal: ok,
		feederProcessGone: ok,
		hostProcessGone: ok,
		queueDrained: ok,
		tokenRequired: false,
		tokenCleanup: ok,
		localClean: true,
		clean: true,
	};
	const samples = [];
	for (const [i, at] of [1000, 13000].entries()) {
		const stored = expected.muxings.flatMap((m) => [
			{ key: `${m.dir.prefix}headers/init.mp4`, size: 700 },
			...Array.from({ length: i + 2 }, (_, n) => ({
				key: `${m.dir.prefix}media/segment_${n + 1}.m4s`,
				size: 2000,
			})),
		]);
		const objects = await sampleLiveStorageObjects(
			expected,
			async (_output, prefix) =>
				listLiveOutputObjects(
					{
						listObjects: async (input) => {
							const matching = stored.filter(
								(o) =>
									o.key.startsWith(prefix) &&
									!(
										mode === "missing" &&
										o.key.includes("/encrypted/headers/init.mp4")
									),
							);
							if (!input.recursive)
								return {
									objects: matching.filter(
										(o) => !o.key.slice(prefix.length).includes("/"),
									),
									prefixes: [`${prefix}headers/`, `${prefix}media/`],
								};
							const at = Number(input.cursor ?? 0);
							return {
								prefixes: [],
								objects: matching.slice(at, at + 2).map((o) => ({
									...o,
									...(mode === "conflict" &&
									prefix.endsWith("encrypted/") &&
									o.key.endsWith("init.mp4")
										? { size: 701 }
										: {}),
								})),
								...(at + 2 < matching.length
									? { nextCursor: String(at + 2) }
									: {}),
							};
						},
					},
					"synthetic-bucket",
					prefix,
				),
		);
		samples.push({ at, status: "RUNNING", objects });
	}
	const leg = assembleLiveEvidence({
		scenario: "nested-encrypted-storage",
		plan,
		expected,
		build: {
			commit: "01234567",
			image: `worker@sha256:${"d".repeat(64)}`,
			planSha256: "b".repeat(64),
		},
		source: {
			location: "synthetic.mov",
			etag: "synthetic-version",
			size: 42,
			sha256: "a".repeat(64),
		},
		channel,
		outputPrefix: "out/",
		samples,
		cleanup,
		manifestFiles: [
			{
				manifestKey: "hls",
				kind: "HLS",
				key: "out/stream.m3u8",
				bytes: 200,
				sha256: "c".repeat(64),
				entries: plan.muxings.length,
			},
		],
		intentTerminal: {
			cleanupState: "CLEANED",
			providerId: channel.providerEncodingId,
			providerIds: [channel.providerEncodingId],
			readback: {
				channelId: channel.channelId,
				cleanup,
				providerStatuses: [
					{ encodingId: channel.providerEncodingId, status: "CANCELED" },
				],
				providerTerminalObservedAt: "2026-10-27T00:01:00.000Z",
				providerIdentityComplete: true,
				providerIdentityConflict: false,
				providerProofUncertain: false,
			},
		},
	}).find((candidate) => candidate.outputLeg === "hls@origin");
	expect(leg).toBeDefined();
	expect(leg?.complete, leg?.missing.join("; ")).toBe(mode === "healthy");
	expect(leg?.children.every((c) => c.media.length === 3)).toBe(true);
	expect(leg?.children.every((c) => !!c.init)).toBe(mode === "healthy");
});

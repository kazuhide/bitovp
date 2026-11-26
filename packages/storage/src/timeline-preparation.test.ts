import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import {
	type TimelinePreparationRow,
	verifyInputTimelinePreparation,
	verifyTimelineObjectDigest,
} from "./timeline-preparation";
import type { ObjectStorageBrowser } from "./types";

function fixture() {
	const org = randomUUID(),
		taskId = randomUUID(),
		probeId = randomUUID(),
		credentialId = randomUUID();
	const bytes = Buffer.from("verified prepared program"),
		sha256 = createHash("sha256").update(bytes).digest("hex");
	const key = `edits/bitovp-generated-inputs/${org}/${taskId}/${randomUUID()}.mp4`;
	const source = {
		key: "source",
		credentialId,
		bucket: "input",
		objectKey: "a.mp4",
	};
	const facts = {
		key: source.key,
		durationMs: 1000,
		video: { width: 960, height: 540, streamIndex: 0 },
		audio: null,
		identity: { size: 8, etag: "source-v1" },
	};
	const request = {
		kind: "TIMELINE_PREPARE",
		probeId,
		document: {
			schemaVersion: 1,
			id: randomUUID(),
			audioEnabled: false,
			clips: [
				{ id: randomUUID(), sourceKey: source.key, inMs: 0, outMs: 1000 },
			],
		},
		output: { credentialId, bucket: "output", prefix: "edits/" },
	};
	const requestHash = createHash("sha256")
		.update(JSON.stringify(request))
		.digest("hex");
	const row: TimelinePreparationRow = {
		id: taskId,
		organizationId: org,
		kind: "TIMELINE_PREPARE",
		status: "SUCCEEDED",
		request,
		requestHash,
		cancelRequestedAt: null,
		expiresAt: new Date("2099-01-01"),
		result: {
			preparation: {
				source: {
					key: "prepared",
					credentialId,
					bucket: "output",
					objectKey: key,
				},
				facts: {
					...facts,
					key: "prepared",
					identity: { size: bytes.length, etag: "output-v1" },
				},
				sha256,
				durationMs: 1000,
				profile: "H264_CRF12_AAC320_SDR8_V1",
			},
		},
	};
	const probe: TimelinePreparationRow = {
		...row,
		id: probeId,
		kind: "PROBE",
		request: { kind: "PROBE", sources: [source] },
		result: { sources: [facts] },
	};
	const base = JSON.parse(
		readFileSync(
			new URL(
				"../../core/src/plan/__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const plan = encodingPlanSchema.parse({
		...base,
		inputs: [{ key: "main", kind: "S3", credentialId, bucket: "output" }],
		ingest: [
			{
				key: "prepared",
				selectionMode: "AUTO",
				inputKey: "main",
				inputPath: key,
			},
		],
		renditions: base.renditions.map((rendition: object) => ({
			...rendition,
			ingestKey: "prepared",
		})),
		inputTimelinePreparation: { taskId, requestHash },
	});
	const browser = {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		headObject: vi.fn(async ({ key: readKey }: { key: string }) =>
			readKey === key
				? { size: bytes.length, etag: "output-v1" }
				: { size: 8, etag: "source-v1" },
		),
		getObject: vi.fn(async () => Readable.from([bytes])),
	} satisfies ObjectStorageBrowser;
	const findTask = vi.fn(async (id: string) =>
		id === taskId ? row : id === probeId ? probe : null,
	);
	return {
		org,
		row,
		probe,
		plan,
		browser,
		bytes,
		sha256,
		verify: () =>
			verifyInputTimelinePreparation({
				plan,
				organizationId: org,
				findTask,
				browserFor: async () => browser,
				signal: new AbortController().signal,
			}),
	};
}

describe("prepared input admission before queue/provider", () => {
	it("admits only an owned, byte-verified single shared ingest", async () => {
		const f = fixture();
		await f.verify();
		expect(f.browser.getObject).toHaveBeenCalledOnce();
	});
	it.each([
		"tenant",
		"request",
		"source",
		"output",
		"rendition",
		"graph",
		"expired",
	])("refuses changed %s evidence", async (change) => {
		const f = fixture();
		if (change === "tenant") f.row.organizationId = randomUUID();
		if (change === "request")
			(
				f.row.request as { document: { audioEnabled: boolean } }
			).document.audioEnabled = true;
		if (change === "source") {
			const source = (
				f.probe.result as { sources: { identity: { etag: string } }[] }
			).sources[0];
			if (!source) throw new Error("Expected source fixture");
			source.identity.etag = "changed";
		}
		if (change === "output")
			f.browser.getObject.mockImplementation(async () =>
				Readable.from([Buffer.from("wrong")]),
			);
		if (change === "rendition") {
			const rendition = f.plan.renditions[0];
			if (!rendition) throw new Error("Expected rendition fixture");
			rendition.ingestKey = "other";
		}
		if (change === "graph") {
			const ingest = f.plan.ingest[0];
			if (!ingest) throw new Error("Expected ingest fixture");
			f.plan.ingest.push({ ...ingest, key: "other" });
		}
		if (change === "expired") f.row.expiresAt = new Date(0);
		await expect(f.verify()).rejects.toThrow();
	});
	it("refuses an unused HDR10+ input even when all renditions consume the verified prepared program", async () => {
		const f = fixture();
		f.plan.hdr10PlusStreams.push({
			key: "unprepared",
			inputKey: "main",
			videoInputPath: "masters/picture.mxf",
			metadataInputPath: "masters/picture.json",
			selectionMode: "AUTO",
		});
		await expect(f.verify()).rejects.toThrow("INPUT_PREPARATION_INVALID");
		expect(f.browser.headObject).not.toHaveBeenCalled();
		expect(f.browser.getObject).not.toHaveBeenCalled();
	});
	it("rejects a separate caption reader before opening the verified prepared object", async () => {
		const f = fixture();
		f.plan.captionStreams.push({
			key: "stale",
			kind: "CEA608",
			channel: "CC1",
			inputKey: "main",
			inputPath: "another.mov",
		});
		await expect(f.verify()).rejects.toThrow("INPUT_PREPARATION_INVALID");
		expect(f.browser.headObject).not.toHaveBeenCalled();
	});
	it("rejects a short clean read despite unchanged storage headers", async () => {
		const f = fixture();
		f.browser.getObject.mockImplementation(async () =>
			Readable.from([f.bytes.subarray(0, 3)]),
		);
		await expect(f.verify()).rejects.toThrow("PREPARATION_OUTPUT_UNVERIFIED");
	});
	it("cancels a pending storage read and destroys a stream that arrives late", async () => {
		let resolve!: (stream: Readable) => void;
		const browser = {
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			getObject: () =>
				new Promise<Readable>((done) => {
					resolve = done;
				}),
		} satisfies ObjectStorageBrowser;
		const controller = new AbortController();
		const pending = verifyTimelineObjectDigest({
			browser,
			bucket: "output",
			key: "x",
			identity: { size: 1, etag: "v1" },
			sha256: "a".repeat(64),
			signal: controller.signal,
		}).then(
			() => "success",
			() => "canceled",
		);
		controller.abort();
		const result = await Promise.race([
			pending,
			new Promise<string>((done) => setTimeout(() => done("stalled"), 20)),
		]);
		const late = Readable.from([Buffer.from("x")]);
		resolve(late);
		await pending;
		expect(result).toBe("canceled");
		expect(late.destroyed).toBe(true);
	});
});

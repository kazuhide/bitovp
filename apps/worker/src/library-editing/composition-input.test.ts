import { createHash } from "node:crypto";
import {
	canonicalEditingJson,
	cfrTimeMapSchema,
	toCompositionDocument,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaVersion } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { resolveCompositionRenderInput } from "./composition-input";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function setup() {
	const probe = {
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				codec_tag_string: "avc1",
				pix_fmt: "yuv420p",
				field_order: "progressive",
				sample_aspect_ratio: "1:1",
				r_frame_rate: "30/1",
				avg_frame_rate: "30/1",
				start_time: "0",
				color_transfer: "bt709",
				color_primaries: "bt709",
				color_space: "bt709",
				width: 320,
				height: 180,
				duration: "2",
				nb_frames: "60",
			},
		],
		format: { format_name: "mov,mp4" },
	};
	const primary: LibraryMediaVersion = {
		sourceId: id(21),
		credentialId: id(5),
		outputCredentialId: id(5),
		durationUs: 2000000n,
		fpsNum: 30,
		fpsDen: 1,
		error: null,
		attempts: 0,
		availableAt: new Date("2026-11-02T00:00:00Z"),
		leaseToken: null,
		leaseUntil: null,
		createdAt: new Date("2026-11-02T00:00:00Z"),
		updatedAt: new Date("2026-11-02T00:00:00Z"),
		id: id(1),
		organizationId: id(10),
		state: "READY",
		sha256: "1".repeat(64),
		width: 320,
		height: 180,
		timeMap: {
			id: id(1),
			mediaVersionId: id(1),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
		probe,
		storage: {
			prepared: {
				credentialId: id(5),
				bucket: "b",
				key: "primary.mp4",
				size: 20,
				expect: { etag: "primary" },
			},
			source: { credentialId: id(5), bucket: "b", key: "original.mp4" },
			output: { credentialId: id(5), bucket: "b", prefix: "out" },
		},
	};
	const extra: LibraryMediaVersion = {
		...structuredClone(primary),
		id: id(2),
		sha256: "2".repeat(64),
		timeMap: {
			...cfrTimeMapSchema.parse(primary.timeMap),
			id: id(2),
			mediaVersionId: id(2),
		},
	};
	const document = toCompositionDocument({
		schemaVersion: 1,
		mediaVersionId: id(1),
		timeMapId: id(1),
		analysisRevisionId: null,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: id(3),
				sourceInUs: 0,
				durationFrames: 30,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
				audio: { mode: "MUTE" },
			},
		],
	});
	document.sources = [{ mediaVersionId: id(2), timeMapId: id(2) }];
	document.imageAssets = [{ id: id(4) }];
	const image = {
		id: id(4),
		organizationId: id(10),
		projectId: id(11),
		sha256: "3".repeat(64),
		storage: {
			credentialId: id(5),
			bucket: "b",
			key: "logo.png",
			size: 100,
			expect: { etag: "logo" },
		},
		width: 32,
		height: 32,
		size: 100n,
	};
	const db = {
		libraryMediaVersion: { findMany: vi.fn().mockResolvedValue([extra]) },
		libraryImageAsset: { findMany: vi.fn().mockResolvedValue([image]) },
		sceneAnalysisRevision: { findFirst: vi.fn().mockResolvedValue(null) },
	};
	const run = () =>
		resolveCompositionRenderInput({
			prisma: db as unknown as AppPrismaClient,
			organizationId: id(10),
			projectId: id(11),
			primary,
			document,
		});
	return { primary, extra, document, image, db, run };
}
describe("pinned multi-source render admission", () => {
	it("separates caption layout policy from previous render hashes while keeping uncaptioned recipes compatible", async () => {
		const f = setup();
		const previousHash = (result: Awaited<ReturnType<typeof f.run>>) =>
			createHash("sha256")
				.update(
					canonicalEditingJson({
						schemaVersion: 2,
						plan: result.plan,
						sources: result.sources
							.map((row) => ({ mediaVersionId: row.id, sha256: row.sha256 }))
							.sort((a, b) =>
								a.mediaVersionId.localeCompare(b.mediaVersionId, "en"),
							),
						images: result.images
							.map((row) => ({ assetId: row.id, sha256: row.sha256 }))
							.sort((a, b) => a.assetId.localeCompare(b.assetId, "en")),
					}),
				)
				.digest("hex");
		const plain = await f.run();
		expect(plain.recipeHash).toBe(previousHash(plain));
		delete f.document.captions;
		const omittedBefore = structuredClone(f.document);
		const omitted = await f.run();
		expect(omitted.recipeHash).toBe(previousHash(omitted));
		expect(omitted.plan.document).not.toHaveProperty("captions");
		expect(f.document).toEqual(omittedBefore);
		f.document.captions = [
			{
				id: id(99),
				fromFrame: 0,
				toFrame: 30,
				text: "あれ俺のお守りあらへんで",
			},
		];
		const before = structuredClone(f.document),
			captioned = await f.run();
		expect(captioned.recipeHash).not.toBe(previousHash(captioned));
		expect((await f.run()).recipeHash).toBe(captioned.recipeHash);
		expect(f.document).toEqual(before);
	});
	it("admits the upload profile's full 2048 square and rejects either oversized axis", async () => {
		const f = setup();
		f.image.width = 2048;
		f.image.height = 2048;
		expect((await f.run()).images[0]).toMatchObject({
			width: 2048,
			height: 2048,
		});
		f.image.width = 2049;
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
		f.image.width = 2048;
		f.image.height = 2049;
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
	});
	it("resolves bounded tenant media/images and hashes every immutable SHA", async () => {
		const f = setup();
		const a = await f.run();
		expect(a.plan.sources.map((s) => s.mediaVersionId)).toEqual([id(1), id(2)]);
		expect(f.db.libraryMediaVersion.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: id(10), id: { in: [id(2)] }, state: "READY" },
				take: 8,
			}),
		);
		expect(
			f.db.libraryImageAsset.findMany.mock.calls[0]?.[0].where,
		).toMatchObject({
			organizationId: id(10),
			OR: [
				{ projectId: id(11) },
				{
					retainedByProjects: {
						some: { projectId: id(11), organizationId: id(10) },
					},
				},
			],
		});
		f.extra.sha256 = "4".repeat(64);
		expect((await f.run()).recipeHash).not.toBe(a.recipeHash);
		f.extra.sha256 = "2".repeat(64);
		f.image.sha256 = "5".repeat(64);
		expect((await f.run()).recipeHash).not.toBe(a.recipeHash);
	});
	it("refuses missing/cross-tenant/not-ready sources before storage access", async () => {
		const f = setup();
		f.extra.organizationId = id(20);
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
		f.extra.organizationId = id(10);
		f.extra.state = "ERROR";
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
		f.db.libraryMediaVersion.findMany.mockResolvedValue([]);
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
	});
	it("refuses changed geometry/time map and cross-tenant images", async () => {
		const f = setup();
		f.image.organizationId = id(20);
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
		f.image.organizationId = id(10);
		f.primary.width = 640;
		await expect(f.run()).rejects.toThrow("INVALID_RENDER_INPUT");
		f.primary.width = 320;
		f.document.sources = [{ mediaVersionId: id(2), timeMapId: id(20) }];
		await expect(f.run()).rejects.toThrow("TIME_MAP_MISMATCH");
	});
	it("checks an additional source analysis association rather than trusting document IDs", async () => {
		const f = setup();
		f.document.sources = [
			{ mediaVersionId: id(2), timeMapId: id(2), analysisRevisionId: id(8) },
		];
		await expect(f.run()).rejects.toThrow("ANALYSIS_BINDING_UNVERIFIED");
	});
});

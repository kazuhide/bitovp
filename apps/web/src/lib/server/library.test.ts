import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./context", () => ({ getServerContext: vi.fn() }));

import { contentRegisterSchema, contentUpdateSchema } from "@bitovp/core";
import { type AppPrismaClient, LibrarySourceError } from "@bitovp/db";
import {
	libraryRoute,
	registerContent,
	sourceView,
	updateContent,
} from "./library";

const sourceId = "a1111111-1111-4111-8111-111111111111";
const contentId = "b1111111-1111-4111-8111-111111111111";
const input = {
	sourceId,
	title: "Sample",
	locale: "en",
	description: "",
	tags: [],
};
const row = {
	...input,
	id: contentId,
	revision: 1,
	archived: false,
	registrationKey: sourceId,
	updatedAt: new Date(),
};
const tx = {
	$queryRaw: vi.fn().mockResolvedValue([]),
	librarySource: { findUnique: vi.fn() },
	sceneAnalysisRevision: { findFirst: vi.fn() },
	content: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
	contentRevision: { findUnique: vi.fn(), create: vi.fn() },
};
const prisma = {
	$transaction: (action: (db: typeof tx) => unknown) => action(tx),
} as unknown as AppPrismaClient;
beforeEach(() => {
	vi.clearAllMocks();
	tx.librarySource.findUnique.mockResolvedValue({
		id: sourceId,
		locales: ["en"],
	});
	tx.sceneAnalysisRevision.findFirst.mockResolvedValue({ id: "analysis" });
	tx.content.findUnique.mockResolvedValue(null);
	tx.content.create.mockResolvedValue(row);
	tx.content.updateMany.mockResolvedValue({ count: 1 });
	tx.contentRevision.findUnique.mockResolvedValue({ sourceId });
});
describe("library writes", () => {
	it("does not expose the private stored-analysis locator in source detail", async () => {
		const db = {
			librarySource: {
				findUnique: async () => ({
					id: sourceId,
					locales: [],
					state: "READY",
					snapshot: {
						schemaVersion: 1,
						kind: "VOD_JOB",
						name: "asset",
						planHash: "hash",
						identity: "UNVERIFIED",
						inputs: [],
						playbackLinks: [],
						qcVerdict: null,
						qcOverriddenAt: null,
						analysisOutput: {
							credentialId: sourceId,
							bucket: "private",
							path: "output/",
							filename: "asset.json",
						},
					},
				}),
			},
			contentRevision: { findMany: async () => [] },
		};
		expect(
			(await sourceView(db as unknown as AppPrismaClient, sourceId)).snapshot,
		).not.toHaveProperty("analysisOutput");
	});
	it("returns only authored guidance, never unexpected provider/DB error prose", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const safe = await libraryRoute(async () => {
				throw new LibrarySourceError(409, "Reload before saving");
			});
			expect(await safe.json()).toEqual({ error: "Reload before saving" });
			const unsafe = await libraryRoute(async () => {
				throw new Error("private provider token");
			});
			expect(unsafe.status).toBe(500);
			expect(await unsafe.json()).toEqual({ error: "Internal error" });
		} finally {
			log.mockRestore();
		}
	});
	it("creates content and immutable revision together", async () => {
		expect(
			await registerContent(prisma, contentRegisterSchema.parse(input), "test"),
		).toBe(contentId);
		expect(tx.content.create).toHaveBeenCalledOnce();
		expect(tx.contentRevision.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					contentId,
					sourceId,
					revision: 1,
					createdBy: "test",
				}),
			}),
		);
	});
	it("replays matching registration without a new revision", async () => {
		tx.content.findUnique.mockResolvedValue(row);
		expect(
			await registerContent(prisma, contentRegisterSchema.parse(input), null),
		).toBe(contentId);
		expect(tx.content.create).not.toHaveBeenCalled();
		expect(tx.contentRevision.create).not.toHaveBeenCalled();
	});
	it("rejects reused registration with different metadata", async () => {
		tx.content.findUnique.mockResolvedValue(row);
		await expect(
			registerContent(
				prisma,
				contentRegisterSchema.parse({ ...input, title: "Other" }),
				null,
			),
		).rejects.toMatchObject({ status: 409 });
	});
	it("allows asset metadata before optional analysis is ready", async () => {
		tx.sceneAnalysisRevision.findFirst.mockResolvedValue(null);
		await expect(
			registerContent(prisma, contentRegisterSchema.parse(input), null),
		).resolves.toBe(contentId);
	});
	it("allows non-AISA metadata with an undetermined locale", async () => {
		tx.librarySource.findUnique.mockResolvedValue({
			id: sourceId,
			locales: [],
		});
		await expect(
			registerContent(
				prisma,
				contentRegisterSchema.parse({ ...input, locale: "und" }),
				null,
			),
		).resolves.toBe(contentId);
		await expect(
			registerContent(
				prisma,
				contentRegisterSchema.parse({ ...input, locale: "ja" }),
				null,
			),
		).rejects.toMatchObject({ status: 400 });
	});
	it("rejects stale edits without appending history", async () => {
		tx.content.findUnique.mockResolvedValue(row);
		await expect(
			updateContent(
				prisma,
				contentId,
				contentUpdateSchema.parse({ expectedRevision: 2, title: "Changed" }),
				null,
			),
		).rejects.toMatchObject({ status: 409 });
		expect(tx.contentRevision.create).not.toHaveBeenCalled();
	});
	it("archives with a new immutable revision, preserving source", async () => {
		tx.content.findUnique.mockResolvedValue(row);
		await updateContent(
			prisma,
			contentId,
			contentUpdateSchema.parse({ expectedRevision: 1, archived: true }),
			"test",
		);
		expect(tx.content.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: contentId, revision: 1 },
				data: expect.objectContaining({ archived: true, revision: 2 }),
			}),
		);
		expect(tx.contentRevision.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ sourceId, revision: 2 }),
			}),
		);
	});
	it("does not permit relinking an archived content", async () => {
		tx.content.findUnique.mockResolvedValue({ ...row, archived: true });
		await expect(
			registerContent(
				prisma,
				contentRegisterSchema.parse({
					...input,
					contentId,
					expectedRevision: 1,
				}),
				null,
			),
		).rejects.toMatchObject({ status: 409 });
	});
});

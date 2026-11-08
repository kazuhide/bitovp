import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { libraryEditingHlsOutputs } from "./library-editing-hls-output";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture() {
	const plan = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
				),
				"utf8",
			),
		),
	);
	const organizationId = randomUUID(),
		encodingId = randomUUID(),
		jobId = randomUUID();
	const source = {
		organizationId,
		sourceKind: "VOD_JOB",
		encodingId,
		jobId: jobId as string | null,
		originalJobId: null as string | null,
	};
	const snapshot = { kind: "VOD_JOB", planHash: hash(plan) };
	const job = {
		organizationId,
		bitmovinEncodingId: encodingId,
		status: "FINISHED",
		plan,
	};
	const findUnique = vi.fn(async () => job);
	const prisma = { encodingJob: { findUnique } } as unknown as AppPrismaClient;
	const run = () =>
		libraryEditingHlsOutputs(prisma, source, snapshot, organizationId);
	return { plan, source, snapshot, job, findUnique, run };
}

describe("private HLS output selection", () => {
	it("loads exact finished encoding coordinates without using a public URL", async () => {
		const f = fixture();
		await expect(f.run()).resolves.toEqual([
			{
				key: "hls:hls",
				kind: "HLS",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "sample-output-bucket",
				path: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/stream.m3u8",
				hlsRootPrefix: "output/h264-aac-fmp4-fixed-bitrate-hls-aws",
			},
		]);
	});
	it.each([
		"organizationId",
		"bitmovinEncodingId",
		"status",
	] as const)("rejects a mismatched retained job %s", async (field) => {
		const f = fixture();
		Object.assign(f.job, {
			[field]: field === "status" ? "RUNNING" : randomUUID(),
		});
		await expect(f.run()).resolves.toEqual([]);
	});
	it("does not reinterpret a changed plan under the stored snapshot", async () => {
		const f = fixture();
		f.plan.name = "Changed";
		await expect(f.run()).resolves.toEqual([]);
	});
	it.each([
		"../other/",
		"/absolute/",
		"https://outside.example/",
	])("rejects an unsafe plan root %s even with a matching plan hash", async (root) => {
		const f = fixture(),
			manifest = f.plan.manifests[0];
		if (!manifest) throw new Error("HLS fixture required");
		manifest.destination.path = root;
		f.snapshot.planHash = hash(f.plan);
		await expect(f.run()).resolves.toEqual([]);
	});
	it("does not use an encrypted manifest as an editable source", async () => {
		const f = fixture(),
			manifest = f.plan.manifests[0];
		if (manifest?.kind !== "HLS") throw new Error("HLS fixture required");
		manifest.drmKind = "FAIRPLAY";
		f.snapshot.planHash = hash(f.plan);
		await expect(f.run()).resolves.toEqual([]);
	});
	it("does not consult another source kind or foreign source", async () => {
		const f = fixture();
		f.source.sourceKind = "DERIVED_RENDER";
		await expect(f.run()).resolves.toEqual([]);
		expect(f.findUnique).not.toHaveBeenCalled();
	});
});

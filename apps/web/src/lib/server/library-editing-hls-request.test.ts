import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";

const state = vi.hoisted(() => ({
	context: {} as ServerContext,
	browser: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: async () => state.context }));
vi.mock("./storage", () => ({ browserForCredentialId: state.browser }));

import { requestEditingMedia } from "./library-editing-media";

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
		sourceId = randomUUID(),
		jobId = randomUUID(),
		encodingId = randomUUID();
	const source = {
		id: sourceId,
		organizationId,
		sourceKind: "VOD_JOB",
		encodingId,
		jobId,
		originalJobId: null,
		snapshot: {
			schemaVersion: 1,
			kind: "VOD_JOB",
			name: "HLS",
			identity: "UNVERIFIED",
			planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
			inputs: [],
			playbackLinks: [],
			fileOutputs: [],
			qcVerdict: null,
			qcOverriddenAt: null,
		},
	};
	const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
		id: randomUUID(),
		state: "PENDING",
		error: null,
		durationUs: null,
		width: null,
		height: null,
		timeMap: null,
		...data,
	}));
	const headObject = vi.fn(async () => ({
		size: 321,
		etag: '"fixed-master"',
		versionId: "master-version",
	}));
	state.browser.mockResolvedValue({
		headObject,
		getObject: vi.fn(),
		putObject: vi.fn(),
		dispose: vi.fn(),
	});
	state.context = {
		tenant: { organizationId },
		prisma: {
			librarySource: { findUnique: async () => source },
			encodingJob: {
				findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
					where.id.in.includes(jobId) ? [{ id: jobId, plan }] : [],
				findUnique: async () => ({
					organizationId,
					bitmovinEncodingId: encodingId,
					status: "FINISHED",
					plan,
				}),
			},
			watchRule: { findMany: async () => [] },
			libraryMediaVersion: { create },
		},
	} as unknown as ServerContext;
	const value = {
		fileKey: "hls:hls",
		output: {
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "sample-output-bucket",
			prefix: "prepared",
		},
	};
	return { sourceId, create, headObject, value };
}
beforeEach(() => state.browser.mockReset());

it("prepares only the encoding-bound HLS locator and pins its identity server-side", async () => {
	const f = fixture();
	const media = await requestEditingMedia(f.sourceId, f.value);
	const data = f.create.mock.calls[0]?.[0]?.data;
	if (!data) throw new Error("Media preparation must be recorded");
	expect(media.state).toBe("PENDING");
	expect(data.storage).toMatchObject({
		sourceFormat: "HLS",
		hlsRootPrefix: "output/h264-aac-fmp4-fixed-bitrate-hls-aws",
		source: {
			credentialId: f.value.output.credentialId,
			bucket: "sample-output-bucket",
			key: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/stream.m3u8",
			size: 321,
			expect: { etag: '"fixed-master"', versionId: "master-version" },
		},
	});
	expect(f.headObject).toHaveBeenCalledWith({
		bucket: "sample-output-bucket",
		key: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/stream.m3u8",
	});
});
it("does not accept a client-selected HLS root or storage source", async () => {
	const f = fixture();
	await expect(
		requestEditingMedia(f.sourceId, {
			...f.value,
			sourceFormat: "HLS",
			hlsRootPrefix: "another-job",
		}),
	).rejects.toThrow();
	expect(f.create).not.toHaveBeenCalled();
	expect(f.headObject).not.toHaveBeenCalled();
});
it("does not read an arbitrary HLS file key outside the retained encoding", async () => {
	const f = fixture();
	await expect(
		requestEditingMedia(f.sourceId, { ...f.value, fileKey: "hls:foreign" }),
	).rejects.toMatchObject({ code: "NO_EDITABLE_MP4" });
	expect(f.create).not.toHaveBeenCalled();
	expect(f.headObject).not.toHaveBeenCalled();
});

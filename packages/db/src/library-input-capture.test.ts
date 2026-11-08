import {
	compilePlan,
	encodingPlanSchema,
	hashEditingEvidence,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import plan from "../../core/src/plan/__fixtures__/ai-scene-analysis-passthrough.plan.json";
import type { AppPrismaClient } from "./client";
import {
	listCapturedOriginalInputs,
	resolveCapturedOriginalInput,
} from "./library-input-capture";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function setup() {
	const source = {
		id: id(2),
		organizationId: id(1),
		sourceKind: "VOD_JOB",
		originalJobId: id(3),
		jobId: id(3),
		encodingId: id(4),
		accountId: id(5),
	};
	const operation = compilePlan(encodingPlanSchema.parse(plan)).find(
		(entry) => entry.kind === "CREATE_INGEST_INPUT_STREAM",
	);
	if (!operation) throw new Error("Missing input fixture");
	const witness = {
		...operation,
		status: "DONE",
		resourceId: id(6),
		request: {
			...operation.payload,
			inputPath: String(operation.payload.inputPath),
			selectionMode: String(operation.payload.selectionMode),
			position: Number(operation.payload.position),
			refs: { encodingId: id(4) },
		},
		response: { id: id(6), providerInputId: id(7), inputReceiptId: id(8) },
	};
	const job = {
		id: id(3),
		organizationId: id(1),
		status: "FINISHED",
		bitmovinEncodingId: id(4),
		bitmovinAccountId: id(5),
		plan: structuredClone(plan),
		stepLog: [witness],
	};
	const proof = {
		schemaVersion: 1,
		profile: "PINNED_HTTP_INPUT_V1",
		organizationId: id(1),
		jobId: id(3),
		encodingId: id(4),
		expiresAt: 1_900_000_000,
		storage: {
			credentialId: plan.inputs[0]?.credentialId,
			bucket: "sample-input-bucket",
			key: "big_buck_bunny_1080p_h264.mov",
			size: 20,
			expect: { versionId: "version-one" },
		},
		sha256: "a".repeat(64),
		sourceFacts: {
			width: 320,
			height: 180,
			codec: "h264",
			fps: { num: 30, den: 1 },
			timeBase: { num: 1, den: 90000 },
			frameCount: 30,
			durationUs: 1_000_000,
			videoPtsHash: "b".repeat(64),
			colorProfile: "BT709_8BIT_LIMITED",
			audio: null,
		},
		ingestKey: "video",
		planHash: hashEditingEvidence(job.plan),
	};
	const receipt = {
		id: id(8),
		organizationId: id(1),
		jobId: id(3),
		encodingId: id(4),
		proof,
		proofHash: hashEditingEvidence(proof),
	};
	const db = {
		librarySource: { findUnique: vi.fn(async () => source) },
		encodingJob: { findUnique: vi.fn(async () => job) },
		libraryEvidenceReceipt: { findMany: vi.fn(async () => [receipt]) },
	};
	const input = {
		prisma: db as unknown as AppPrismaClient,
		organizationId: id(1),
		sourceId: source.id,
	};
	return { source, job, witness, receipt, input, db };
}
describe("captured original eligibility reads only proved provider input", () => {
	it("returns the exact fixed storage and indexed source behind a finished ingest witness", async () => {
		const f = setup();
		expect(
			await resolveCapturedOriginalInput({ ...f.input, receiptId: id(8) }),
		).toMatchObject({
			receiptId: id(8),
			storage: f.receipt.proof.storage,
			sourceFacts: f.receipt.proof.sourceFacts,
			providerInputId: id(7),
			ingestStreamId: id(6),
		});
	});
	it.each([
		[
			"tenant",
			(f: ReturnType<typeof setup>) => {
				f.source.organizationId = id(99);
			},
		],
		[
			"unfinished",
			(f: ReturnType<typeof setup>) => {
				f.job.status = "RUNNING";
			},
		],
		[
			"account",
			(f: ReturnType<typeof setup>) => {
				f.job.bitmovinAccountId = id(99);
			},
		],
		[
			"encoding",
			(f: ReturnType<typeof setup>) => {
				f.job.bitmovinEncodingId = id(99);
			},
		],
		[
			"plan",
			(f: ReturnType<typeof setup>) => {
				f.job.plan.name = "changed";
			},
		],
		[
			"receipt hash",
			(f: ReturnType<typeof setup>) => {
				f.receipt.proofHash = "c".repeat(64);
			},
		],
		[
			"unrecorded input",
			(f: ReturnType<typeof setup>) => {
				f.witness.response.inputReceiptId = id(99);
			},
		],
		[
			"provider input",
			(f: ReturnType<typeof setup>) => {
				f.witness.response.providerInputId = "invalid";
			},
		],
		[
			"wrong request encoding",
			(f: ReturnType<typeof setup>) => {
				f.witness.request.refs.encodingId = id(99);
			},
		],
		[
			"not DONE",
			(f: ReturnType<typeof setup>) => {
				f.witness.status = "RUNNING";
			},
		],
		[
			"unrecorded video selection",
			(f: ReturnType<typeof setup>) => {
				f.witness.request.selectionMode = "AUDIO_RELATIVE";
			},
		],
	])("does not expose an unproved %s capture", async (_label, mutate) => {
		const f = setup();
		mutate(f);
		expect(await listCapturedOriginalInputs(f.input)).toEqual([]);
	});
	it("does not resolve an arbitrary client receipt id", async () => {
		const f = setup();
		expect(
			await resolveCapturedOriginalInput({ ...f.input, receiptId: id(99) }),
		).toBeNull();
	});
});

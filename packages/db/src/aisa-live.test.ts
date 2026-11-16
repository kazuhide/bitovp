import { expect, it, vi } from "vitest";
import { persistFinalAisaImport } from "./aisa-live";

const analysisId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const encodingId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const accountId = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const proof = {
	analysisId,
	encodingId,
	analysisStatus: "FINISHED" as const,
	encodingStatus: "FINISHED" as const,
	bitmovinAccountId: accountId,
	name: "Imported final",
	createdAt: new Date("2026-11-07T07:00:00Z"),
	startedAt: new Date("2026-11-07T07:01:00Z"),
	finishedAt: new Date("2026-11-07T07:05:00Z"),
	observedAt: new Date("2026-11-07T08:00:00Z"),
	snapshot: {
		analysisId,
		encodingId,
		isFinal: true,
		sequence: 2,
		observations: [],
		keyMoments: [],
	},
};

function fake() {
	let saved: {
		id: string;
		liveChannelId: string;
		bitmovinEncodingId: string;
		aisaAnalysisId: string;
		liveChannel: { bitmovinAccountId: string; origin: string };
	} | null = null;
	const writes: Record<string, unknown>[] = [];
	const tx = {
		liveChannelRun: {
			findFirst: vi.fn(
				async ({
					where,
				}: {
					where: {
						OR: { aisaAnalysisId?: string; bitmovinEncodingId?: string }[];
					};
				}) =>
					saved &&
					where.OR.some(
						(clause) =>
							clause.aisaAnalysisId === saved?.aisaAnalysisId ||
							clause.bitmovinEncodingId === saved?.bitmovinEncodingId,
					)
						? saved
						: null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				writes.push(data);
				saved = {
					id: String(data.id),
					liveChannelId: String(data.liveChannelId),
					bitmovinEncodingId: encodingId,
					aisaAnalysisId: analysisId,
					liveChannel: {
						bitmovinAccountId: accountId,
						origin: "AISA_IMPORTED",
					},
				};
				return saved;
			}),
		},
		liveChannel: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				writes.push(data);
				return { id: data.id };
			}),
		},
	};
	const prisma = {
		...tx,
		$transaction: vi.fn(async (run: (value: typeof tx) => Promise<unknown>) =>
			run(tx),
		),
	};
	return {
		prisma,
		writes,
		tx,
		seed: (value: NonNullable<typeof saved>) => {
			saved = value;
		},
	};
}

it("persists actual final provider identities and zero moments in real channel/run rows without a fake normal plan", async () => {
	const { prisma, writes } = fake();
	const outcome = await persistFinalAisaImport(
		prisma as never,
		proof,
		"user:test",
	);
	expect(outcome.imported).toBe(true);
	expect(writes).toHaveLength(2);
	expect(writes[0]).toMatchObject({
		origin: "AISA_IMPORTED",
		status: "STOPPED",
		error: null,
		bitmovinEncodingId: encodingId,
		bitmovinAccountId: accountId,
		createdBy: "user:test",
		plan: { planVersion: "aisa-live-import-v1", analysisId },
	});
	expect(writes[0]?.plan).not.toHaveProperty("renditions");
	expect(writes[1]).toMatchObject({
		seq: 1,
		status: "STOPPED",
		error: null,
		aisaAnalysisId: analysisId,
		aisaStatus: "FINISHED",
		aisaSnapshot: proof.snapshot,
		bitmovinEncodingId: encodingId,
		providerStatus: "FINISHED",
		runningSince: proof.startedAt,
		endedAt: proof.finishedAt,
		stepLog: [],
	});
});

it.each([
	["FINISHED", "FINISHED"],
	["FINISHED", "ERROR"],
	["ERROR", "FINISHED"],
	["ERROR", "ERROR"],
] as const)("preserves verified Analysis %s and Encoding %s without turning provider errors into success", async (analysisStatus, encodingStatus) => {
	const { prisma, writes } = fake();
	const terminalProof = {
		...proof,
		analysisStatus,
		encodingStatus,
		snapshot: {
			...proof.snapshot,
			observations: [{ id: "observation-a", text: "Synthetic event" }],
			keyMoments: [{ id: "moment-a", categories: ["sport/soccer"] }],
			sourceGaps: [
				{
					startTimeSeconds: 3600,
					endTimeSeconds: 3600.033333,
					reason: "FINALIZATION_BACKLOG",
				},
			],
		},
	};
	const failed = analysisStatus === "ERROR" || encodingStatus === "ERROR";
	await persistFinalAisaImport(prisma as never, terminalProof);
	expect(writes).toHaveLength(2);
	for (const row of writes) {
		expect(row).toMatchObject({
			status: failed ? "ERROR" : "STOPPED",
			error: failed ? expect.any(String) : null,
			encoderStoppedConfirmedFor: encodingId,
		});
	}
	expect(writes[1]).toMatchObject({
		aisaStatus: analysisStatus,
		providerStatus: encodingStatus,
		aisaSnapshot: terminalProof.snapshot,
		providerTerminalAt: proof.observedAt,
		providerStatusObservedAt: proof.observedAt,
		runningSince: proof.startedAt,
		endedAt: proof.finishedAt,
	});
	const repeated = await persistFinalAisaImport(prisma as never, terminalProof);
	expect(repeated.imported).toBe(false);
	expect(writes).toHaveLength(2);
});

it.each([
	"analysisStatus",
	"encodingStatus",
] as const)("rejects missing, unknown or nonterminal %s proof before any database access", async (field) => {
	for (const status of [
		undefined,
		null,
		"CREATED",
		"QUEUED",
		"RUNNING",
		"CANCELED",
		"TRANSFER_ERROR",
		"UNKNOWN",
	]) {
		const { prisma, writes } = fake();
		await expect(
			persistFinalAisaImport(
				prisma as never,
				{
					...proof,
					[field]: status,
				} as never,
			),
		).rejects.toThrow(/FINISHED|ERROR|terminal/);
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(prisma.liveChannelRun.findFirst).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
	}
});

it.each([
	{ ...proof.snapshot, isFinal: false },
	{ ...proof.snapshot, analysisId: encodingId },
	{ ...proof.snapshot, encodingId: analysisId },
])("rejects nonfinal or foreign snapshot proof before writes", async (snapshot) => {
	const { prisma, writes } = fake();
	await expect(
		persistFinalAisaImport(prisma as never, { ...proof, snapshot }),
	).rejects.toThrow(/identities|finality/);
	expect(prisma.$transaction).not.toHaveBeenCalled();
	expect(writes).toEqual([]);
});

it("returns the same association on repeated import without a second write", async () => {
	const { prisma, writes } = fake();
	const first = await persistFinalAisaImport(prisma as never, proof);
	const second = await persistFinalAisaImport(prisma as never, proof);
	expect(second).toEqual({ ...first, imported: false });
	expect(writes).toHaveLength(2);
});

it("refuses an identity already associated with a different account", async () => {
	const { prisma, seed, writes } = fake();
	seed({
		id: "existing-run",
		liveChannelId: "existing-channel",
		bitmovinEncodingId: encodingId,
		aisaAnalysisId: analysisId,
		liveChannel: {
			bitmovinAccountId: "different-account",
			origin: "AISA_IMPORTED",
		},
	});
	await expect(persistFinalAisaImport(prisma as never, proof)).rejects.toThrow(
		/already associated/i,
	);
	expect(writes).toEqual([]);
});

it("rejects an encoding already owned by an ordinary run", async () => {
	const { prisma, seed, writes } = fake();
	seed({
		id: "existing-run",
		liveChannelId: "existing-channel",
		bitmovinEncodingId: encodingId,
		aisaAnalysisId: "different-analysis",
		liveChannel: { bitmovinAccountId: accountId, origin: "MANAGED" },
	});
	await expect(persistFinalAisaImport(prisma as never, proof)).rejects.toThrow(
		/already associated/i,
	);
	expect(writes).toEqual([]);
});

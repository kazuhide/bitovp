import type {
	EncodingExperimentCampaign,
	EncodingExperimentTrial,
	Prisma,
} from "../generated/client";
import type { AppPrismaClient, AppTransactionClient } from "./client";

export type ExperimentContext = {
	organizationId: string;
	prisma: AppPrismaClient;
};

export class EncodingExperimentError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly field?: string,
	) {
		super(message);
		this.name = "EncodingExperimentError";
	}

	get retryable(): boolean {
		return this.status === 429 || this.status === 503;
	}
}

const pageSize = 100;
const maxAttempts = 3;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function noCampaign(): never {
	throw new EncodingExperimentError(
		404,
		"CAMPAIGN_NOT_FOUND",
		"Experiment campaign not found",
	);
}

function checkCursor(cursor: string | undefined): void {
	if (cursor !== undefined && !uuidPattern.test(cursor)) throw invalidCursor();
}

function invalidCursor() {
	return new EncodingExperimentError(
		400,
		"INVALID_CURSOR",
		"Invalid experiment cursor",
	);
}

function campaignWhere(organizationId: string, id: string) {
	if (!uuidPattern.test(id)) noCampaign();
	return { organizationId, id };
}

async function lockCampaign(
	tx: AppTransactionClient,
	organizationId: string,
	id: string,
) {
	const where = campaignWhere(organizationId, id);
	const rows = await tx.$queryRaw<{ id: string }[]>`
		SELECT "id" FROM "EncodingExperimentCampaign"
		WHERE "id" = ${id}::uuid AND "organizationId" = ${organizationId}::uuid
		FOR UPDATE
	`;
	return rows.length
		? tx.encodingExperimentCampaign.findFirstOrThrow({ where })
		: noCampaign();
}

function campaignSummary(campaign: EncodingExperimentCampaign) {
	return {
		id: campaign.id,
		name: campaign.name,
		capabilityId: campaign.capabilityId,
		state: campaign.state,
		sealed: campaign.sealed,
		createdAt: campaign.createdAt,
	};
}

export function experimentTrialSummary(trial: EncodingExperimentTrial) {
	return {
		id: trial.id,
		trialKey: trial.trialKey,
		sourceSha256: trial.sourceSha256,
		status: trial.status,
		attempt: trial.attempt,
		input: trial.input,
		result: trial.result,
		failureCode: trial.failureCode,
		resultSequence: trial.resultSequence,
	};
}

export async function addExperimentCampaign(
	ctx: ExperimentContext,
	data: { name: string; capabilityId: string; runtime: Prisma.InputJsonValue },
) {
	return campaignSummary(
		await ctx.prisma.encodingExperimentCampaign.create({
			data: { ...data, organizationId: ctx.organizationId },
		}),
	);
}

export async function experimentCampaignDetail(
	ctx: ExperimentContext,
	id: string,
) {
	const campaign = await ctx.prisma.encodingExperimentCampaign.findFirst({
		where: campaignWhere(ctx.organizationId, id),
	});
	if (!campaign) return noCampaign();
	const counts = await ctx.prisma.encodingExperimentTrial.groupBy({
		by: ["status"],
		where: { organizationId: ctx.organizationId, campaignId: id },
		_count: { _all: true },
	});
	return {
		...campaignSummary(campaign),
		runtime: campaign.runtime,
		statusCounts: Object.fromEntries(
			counts.map((row) => [row.status, row._count._all]),
		),
	};
}

export async function experimentCampaignPage(
	ctx: ExperimentContext,
	cursor?: string,
) {
	checkCursor(cursor);
	const rows = await ctx.prisma.encodingExperimentCampaign.findMany({
		where: {
			organizationId: ctx.organizationId,
			id: cursor ? { gt: cursor } : undefined,
		},
		orderBy: { id: "asc" },
		take: pageSize + 1,
	});
	return idPage(rows, campaignSummary);
}

function idPage<T extends { id: string }, U>(rows: T[], map: (row: T) => U) {
	return {
		items: rows.slice(0, pageSize).map(map),
		nextCursor:
			rows.length > pageSize ? (rows[pageSize - 1]?.id ?? null) : null,
	};
}

export async function experimentTrialPage(
	ctx: ExperimentContext,
	id: string,
	cursor?: string,
) {
	checkCursor(cursor);
	const campaign = await ctx.prisma.encodingExperimentCampaign.findFirst({
		where: campaignWhere(ctx.organizationId, id),
		select: { id: true },
	});
	if (!campaign) return noCampaign();
	const rows = await ctx.prisma.encodingExperimentTrial.findMany({
		where: {
			organizationId: ctx.organizationId,
			campaignId: id,
			id: cursor ? { gt: cursor } : undefined,
		},
		orderBy: { id: "asc" },
		take: pageSize + 1,
	});
	return idPage(rows, experimentTrialSummary);
}

export async function experimentResultPage(
	ctx: ExperimentContext,
	id: string,
	cursor?: string,
) {
	const campaign = await ctx.prisma.encodingExperimentCampaign.findFirst({
		where: campaignWhere(ctx.organizationId, id),
		select: { resultSequence: true },
	});
	if (!campaign) return noCampaign();
	let snapshot = campaign.resultSequence;
	let after = 0;
	if (cursor !== undefined) {
		const [scope, max, offset, ...extra] = cursor.split(":");
		if (
			scope !== id ||
			extra.length ||
			!/^\d{1,10}$/.test(max ?? "") ||
			!/^\d{1,10}$/.test(offset ?? "")
		)
			throw invalidCursor();
		snapshot = Number(max);
		after = Number(offset);
		if (after > snapshot || snapshot > campaign.resultSequence)
			throw invalidCursor();
	}
	const rows = await ctx.prisma.encodingExperimentTrial.findMany({
		where: {
			organizationId: ctx.organizationId,
			campaignId: id,
			resultSequence: { gt: after, lte: snapshot },
		},
		orderBy: { resultSequence: "asc" },
		take: pageSize + 1,
	});
	return {
		items: rows.slice(0, pageSize).map(experimentTrialSummary),
		nextCursor:
			rows.length > pageSize
				? `${id}:${snapshot}:${rows[pageSize - 1]?.resultSequence}`
				: null,
		snapshot,
	};
}

export async function controlExperimentCampaign(
	ctx: ExperimentContext,
	id: string,
	action: "pause" | "resume" | "seal" | "cancel",
) {
	return ctx.prisma.$transaction(async (tx) => {
		const campaign = await lockCampaign(tx, ctx.organizationId, id);
		if (campaign.state === "CANCELED") {
			if (action === "cancel") return campaignSummary(campaign);
			throw new EncodingExperimentError(
				409,
				"CAMPAIGN_CLOSED",
				"Experiment campaign is canceled",
			);
		}
		let resultSequence = campaign.resultSequence;
		if (action === "cancel") {
			// The campaign lock serializes sequence assignment with every terminal commit.
			const canceled = await tx.$executeRaw`
				UPDATE "EncodingExperimentTrial" t SET "status" = 'CANCELED', "failureCode" = 'CANCELED',
					"leaseUntil" = NULL, "resultSequence" = ${resultSequence} + pending.n
				FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS n
					FROM "EncodingExperimentTrial"
					WHERE "organizationId" = ${ctx.organizationId}::uuid AND "campaignId" = ${id}::uuid
					AND "status" IN ('PENDING', 'RUNNING')) pending
				WHERE t."id" = pending."id" AND t."organizationId" = ${ctx.organizationId}::uuid
			`;
			resultSequence += canceled;
		}
		const next = await tx.encodingExperimentCampaign.update({
			where: { id, organizationId: ctx.organizationId },
			data: {
				state:
					action === "pause"
						? "PAUSED"
						: action === "resume"
							? "RUNNING"
							: action === "cancel"
								? "CANCELED"
								: campaign.state,
				sealed: campaign.sealed || action === "seal" || action === "cancel",
				resultSequence,
			},
		});
		return campaignSummary(next);
	});
}

type NewTrial = {
	trialKey: string;
	sourceSha256: string;
	input: Prisma.InputJsonValue;
};
type BatchReceipt = {
	items: {
		id: string;
		trialKey: string;
		status: EncodingExperimentTrial["status"];
	}[];
	nextCursor: null;
};

export async function enqueueExperimentBatch(
	ctx: ExperimentContext,
	id: string,
	key: string,
	requestHash: string,
	prepare: (campaign: EncodingExperimentCampaign) => Promise<NewTrial[]>,
): Promise<BatchReceipt> {
	const organizationId = ctx.organizationId;
	return ctx.prisma.$transaction(async (tx) => {
		const campaign = await lockCampaign(tx, organizationId, id);
		const prior = await tx.encodingExperimentBatch.findUnique({
			where: {
				organizationId_campaignId_key: { organizationId, campaignId: id, key },
			},
		});
		if (prior) {
			if (prior.requestHash !== requestHash)
				throw new EncodingExperimentError(
					409,
					"IDEMPOTENCY_CONFLICT",
					"Idempotency key already binds another batch",
				);
			return prior.response as BatchReceipt;
		}
		if (campaign.sealed || campaign.state === "CANCELED")
			throw new EncodingExperimentError(
				409,
				"CAMPAIGN_CLOSED",
				"Experiment campaign is closed for submissions",
			);
		const trials = await prepare(campaign);
		await tx.encodingExperimentTrial.createMany({
			data: trials.map((trial) => ({
				...trial,
				organizationId,
				campaignId: id,
			})),
			skipDuplicates: true,
		});
		const inserted = await tx.encodingExperimentTrial.findMany({
			where: {
				organizationId,
				campaignId: id,
				trialKey: { in: trials.map(({ trialKey }) => trialKey) },
			},
			select: { id: true, trialKey: true, status: true },
		});
		const byKey = new Map(inserted.map((row) => [row.trialKey, row]));
		const response = {
			items: trials.map(({ trialKey }) => {
				const row = byKey.get(trialKey);
				if (!row) throw new Error("Experiment enqueue did not persist a trial");
				return row;
			}),
			nextCursor: null,
		};
		await tx.encodingExperimentBatch.create({
			data: { organizationId, campaignId: id, key, requestHash, response },
		});
		return response;
	});
}

type Outcome = { result: Prisma.InputJsonValue } | { failureCode: string };
type TrialClaim = Pick<
	EncodingExperimentTrial,
	"id" | "campaignId" | "attempt"
>;

export async function claimExperimentTrial(
	ctx: ExperimentContext,
	capabilityId: string,
	now: Date,
	leaseMs: number,
) {
	const organizationId = ctx.organizationId;
	return ctx.prisma.$transaction(async (tx) => {
		const ready = {
			organizationId,
			OR: [
				{ status: "PENDING" },
				{ status: "RUNNING", leaseUntil: { lte: now } },
			],
		} satisfies Prisma.EncodingExperimentTrialWhereInput;
		const trial = await tx.encodingExperimentTrial.findFirst({
			where: { ...ready, campaign: { capabilityId, state: "RUNNING" } },
			orderBy: { id: "asc" },
		});
		if (!trial) return null;
		const campaign = await lockCampaign(tx, organizationId, trial.campaignId);
		if (campaign.state !== "RUNNING" || campaign.capabilityId !== capabilityId)
			return null;
		const where = { ...ready, id: trial.id, attempt: trial.attempt };
		if (trial.attempt >= maxAttempts) {
			const expired = await tx.encodingExperimentTrial.updateMany({
				where,
				data: {
					status: "FAILED",
					failureCode: "WORKER_LEASE_EXPIRED",
					leaseUntil: null,
					resultSequence: campaign.resultSequence + 1,
				},
			});
			if (expired.count) await advanceResults(tx, campaign);
			return null;
		}
		const changed = await tx.encodingExperimentTrial.updateMany({
			where,
			data: {
				status: "RUNNING",
				attempt: { increment: 1 },
				leaseUntil: new Date(now.getTime() + leaseMs),
			},
		});
		return changed.count
			? { ...trial, status: "RUNNING" as const, attempt: trial.attempt + 1 }
			: null;
	});
}

function liveClaim(organizationId: string, claim: TrialClaim, now: Date) {
	return {
		organizationId,
		campaignId: claim.campaignId,
		id: claim.id,
		attempt: claim.attempt,
		status: "RUNNING",
		leaseUntil: { gt: now },
	} satisfies Prisma.EncodingExperimentTrialWhereInput;
}

export async function renewExperimentTrial(
	ctx: ExperimentContext,
	claim: TrialClaim,
	now: Date,
	leaseMs: number,
) {
	const updated = await ctx.prisma.encodingExperimentTrial.updateMany({
		where: liveClaim(ctx.organizationId, claim, now),
		data: { leaseUntil: new Date(now.getTime() + leaseMs) },
	});
	return updated.count === 1;
}

async function advanceResults(
	tx: AppTransactionClient,
	campaign: EncodingExperimentCampaign,
) {
	await tx.encodingExperimentCampaign.update({
		where: { id: campaign.id, organizationId: campaign.organizationId },
		data: { resultSequence: { increment: 1 } },
	});
}

export async function completeExperimentTrial(
	ctx: ExperimentContext,
	claim: TrialClaim,
	now: Date,
	outcome: Outcome,
) {
	return ctx.prisma.$transaction(async (tx) => {
		const campaign = await lockCampaign(
			tx,
			ctx.organizationId,
			claim.campaignId,
		);
		if (campaign.state === "CANCELED") return false;
		const updated = await tx.encodingExperimentTrial.updateMany({
			where: liveClaim(ctx.organizationId, claim, now),
			data: {
				...outcome,
				status: "result" in outcome ? "SUCCEEDED" : "FAILED",
				leaseUntil: null,
				resultSequence: campaign.resultSequence + 1,
			},
		});
		if (updated.count) await advanceResults(tx, campaign);
		return updated.count === 1;
	});
}

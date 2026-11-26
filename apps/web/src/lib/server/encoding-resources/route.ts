import {
	childCollectionsFor,
	childFields,
	readChildPage,
} from "./muxing-children";
import "server-only";
import BitmovinApi from "@bitmovin/api-sdk";
import {
	classifyProviderStatusWord,
	normalizeLiveToVodRecord,
	type StepLogEntry,
	stepLogSchema,
} from "@bitovp/core";
import type { AppTransactionClient } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import { aisaLiveAccessAllowed } from "../aisa-live-access";
import { getServerContext, type ServerContext } from "../context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "../http";
import { isAisaLiveChannelView } from "../live-channel-aisa-view";
import { InvalidResourceResponse } from "./family";
import { removalAllowed } from "./retirement";
import { object, parseResourceLog, selectResource } from "./selection";

export type ResourceOwner =
	| { jobId: string }
	| { channelId: string; runId: string };
const query = z
	.strictObject({
		step: z.string().min(1).max(512),
		attempt: z.coerce.number().int().min(0),
		view: z
			.enum([
				"detail",
				"siblings",
				"customData",
				"children",
				"childDetail",
				"childMetadata",
			])
			.default("detail"),
		collection: z.string().min(1).max(48).optional(),
		childId: z.uuid().optional(),
		offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
	})
	.refine((input) => {
		const childView =
			input.view === "children" ||
			input.view === "childDetail" ||
			input.view === "childMetadata";
		return (
			childView === !!input.collection &&
			!!input.childId ===
				(input.view === "childDetail" || input.view === "childMetadata")
		);
	}, "Invalid muxing child selection.");
const pageSize = 25;
const headers = { "Cache-Control": "private, no-store" };
const respond = (body: unknown) => NextResponse.json(body, { headers });

export async function resourceSource(
	ctx: ServerContext,
	owner: ResourceOwner,
	db: Pick<AppTransactionClient, "encodingJob" | "liveChannelRun"> = ctx.prisma,
) {
	if ("jobId" in owner) {
		const row = await db.encodingJob.findUnique({
			where: { id: owner.jobId },
			select: {
				id: true,
				createdAt: true,
				bitmovinAccountId: true,
				status: true,
				bitmovinEncodingId: true,
				encoderStoppedConfirmedFor: true,
				plan: true,
				stepLog: true,
			},
		});
		if (row)
			return {
				...row,
				retainedOutputIds: new Set<string>(),
				removable:
					row.status === "FINISHED" ||
					(["ERROR", "CANCELED"].includes(row.status) &&
						!!row.bitmovinEncodingId &&
						row.encoderStoppedConfirmedFor === row.bitmovinEncodingId),
			};
	} else {
		const run = await db.liveChannelRun.findFirst({
			where: { id: owner.runId, liveChannelId: owner.channelId },
			select: {
				id: true,
				status: true,
				stepLog: true,
				error: true,
				bitmovinEncodingId: true,
				providerStatus: true,
				providerTerminalAt: true,
				liveToVod: true,
				encoderStoppedConfirmedFor: true,
				aisaAnalysisId: true,
				aisaStatus: true,
				aisaSnapshot: true,
				liveChannel: {
					select: {
						origin: true,
						status: true,
						error: true,
						bitmovinEncodingId: true,
						encoderStoppedConfirmedFor: true,
						stepLog: true,
						provisionClaimedAt: true,
						liveToVod: true,
						plan: true,
						createdAt: true,
						bitmovinAccountId: true,
					},
				},
			},
		});
		if (
			run &&
			(!isAisaLiveChannelView(run.liveChannel, run) ||
				aisaLiveAccessAllowed(ctx.tenant))
		) {
			// Publication reuses the current channel journal, even before an attempt exists.
			const journal = stepLogSchema.safeParse(run.liveChannel.stepLog);
			const retainedOutputIds = new Set<string>();
			for (const entry of journal.data ?? [])
				if (
					entry.step.startsWith("output:") &&
					entry.status === "DONE" &&
					entry.resourceId
				)
					retainedOutputIds.add(entry.resourceId);
			const rawPublications = [run.liveToVod, run.liveChannel.liveToVod];
			const publications = rawPublications.map(normalizeLiveToVodRecord);
			for (const attempt of publications)
				if (attempt?.outputId) retainedOutputIds.add(attempt.outputId);
			return {
				...run.liveChannel,
				retainedOutputIds,
				id: run.id,
				removable:
					journal.success &&
					publications.every(
						(attempt, i) =>
							rawPublications[i] == null || attempt?.status === "FINISHED",
					) &&
					run.liveChannel.origin === "MANAGED" &&
					!run.liveChannel.provisionClaimedAt &&
					["STOPPED", "ERROR"].includes(run.liveChannel.status) &&
					((run.liveChannel.status === "STOPPED" && !run.liveChannel.error) ||
						(!!run.liveChannel.bitmovinEncodingId &&
							run.liveChannel.encoderStoppedConfirmedFor ===
								run.liveChannel.bitmovinEncodingId)) &&
					((run.status === "STOPPED" && !run.error) ||
						(run.status === "ERROR" &&
							!!run.bitmovinEncodingId &&
							run.encoderStoppedConfirmedFor === run.bitmovinEncodingId &&
							!!run.providerTerminalAt &&
							classifyProviderStatusWord(run.providerStatus) === "TERMINAL")) &&
					!isAisaLiveChannelView(run.liveChannel, run),
				stepLog: run.stepLog,
				status: run.status,
			};
		}
	}
	return null;
}
export function mayRemove(ctx: ServerContext) {
	return (
		!!ctx.tenant &&
		!ctx.tenant.isImpersonating &&
		roleAtLeast(ctx.tenant.role, "OPERATOR")
	);
}

type AccountSource = {
	plan: unknown;
	bitmovinAccountId: string | null;
	createdAt: Date;
};
type ResourceSelection = NonNullable<ReturnType<typeof selectResource>>;
function recordedAccountId(row: AccountSource, entry: StepLogEntry) {
	const fromPlan = object(object(row.plan)?.bitmovin)?.accountId;
	return (
		entry.resourceAccount?.id ??
		(typeof fromPlan === "string" ? fromPlan : row.bitmovinAccountId)
	);
}
export function recordedScopeMatches(
	row: AccountSource,
	selected: ResourceSelection,
	access: {
		id: string;
		resourceScopeVersion: string;
		resourceScopeSince: Date;
	},
) {
	if (recordedAccountId(row, selected.entry) !== access.id) return false;
	return [selected.entry.resourceAccount, ...selected.parentScopes].every(
		(scope) =>
			scope
				? scope.id === access.id &&
					scope.version === access.resourceScopeVersion
				: access.resourceScopeSince < row.createdAt,
	);
}
export async function originalAccess(
	ctx: ServerContext,
	row: AccountSource,
	selected: ResourceSelection,
) {
	const id = recordedAccountId(row, selected.entry);
	if (!id) return null;
	const credentials = await ctx.bitmovinAccounts.revealForEncoding(id);
	if (!credentials) return null;
	const access = { ...credentials, id };
	return recordedScopeMatches(row, selected, access) ? access : null;
}

export function resourceSdk(
	access: NonNullable<Awaited<ReturnType<typeof originalAccess>>>,
	signal: AbortSignal,
	id: string,
) {
	return new BitmovinApi({
		apiKey: access.apiKey,
		...(access.tenantOrgId ? { tenantOrgId: access.tenantOrgId } : {}),
		fetch: async (url, init) => {
			const response = await fetch(url, { ...init, signal });
			if (!response.ok) return response;
			let body: unknown;
			try {
				body = await response.clone().json();
			} catch {
				throw new InvalidResourceResponse();
			}
			const result = object(object(object(body)?.data)?.result);
			if (!result) throw new InvalidResourceResponse();
			const path = new URL(String(url)).pathname.replace(/\/$/, "");
			if (path.toLowerCase().endsWith("/customdata")) {
				if (!object(result.customData)) throw new InvalidResourceResponse();
			} else if (path.endsWith(`/${encodeURIComponent(id)}`)) {
				if (result.id !== id) throw new InvalidResourceResponse();
			} else if (
				!Array.isArray(result.items) ||
				typeof result.totalCount !== "number"
			)
				throw new InvalidResourceResponse();
			return response;
		},
	});
}

export async function readResources(req: Request, owner: ResourceOwner) {
	for (const id of Object.values(owner)) {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
	}
	const params = new URL(req.url).searchParams;
	const parsed = params.size
		? query.safeParse(Object.fromEntries(params))
		: null;
	if (parsed && !parsed.success) return validationError(parsed.error);
	try {
		const ctx = await getServerContext();
		const row = await resourceSource(ctx, owner);
		if (!row) return jsonError(404, "Not found");
		const log = parseResourceLog(row.stepLog);
		if (!log)
			return jsonError(409, "The recorded resource history is unavailable.");
		if (!parsed) {
			const receipts = await ctx.prisma.encodingResourceRemoval.findMany({
				where:
					"jobId" in owner
						? { sourceKind: "VOD", sourceId: owner.jobId }
						: {
								sourceKind: "LIVE",
								sourceId: owner.runId,
								channelId: owner.channelId,
							},
				select: { step: true, attempt: true, providerId: true, state: true },
			});
			const states = new Map(
				receipts.map((row) => [
					JSON.stringify([row.step, row.attempt, row.providerId]),
					row.state,
				]),
			);
			return respond({
				canManage: mayRemove(ctx),
				canRemove: mayRemove(ctx) && removalAllowed(owner, row.removable),
				resources: [...log.steps.keys()].flatMap((step) => {
					const s = selectResource(log, step)?.summary;
					return s
						? [
								{
									...s,
									retainedForPublication: row.retainedOutputIds.has(s.id),
									removalState:
										states.get(JSON.stringify([s.step, s.attempt, s.id])) ??
										null,
								},
							]
						: [];
				}),
			});
		}
		const { step, attempt, view, offset } = parsed.data;
		const selected = selectResource(log, step);
		if (!selected)
			return jsonError(404, "Resource not found in this execution.");
		const { entry, address, family } = selected;
		if ((entry.attempt ?? 0) !== attempt)
			return jsonError(
				409,
				"This resource was replaced. Refresh the execution.",
			);
		const access = await originalAccess(ctx, row, selected);
		if (!access)
			return jsonError(
				409,
				"The resource's original provider account cannot be verified.",
			);
		if (view === "siblings" && !family.list)
			return jsonError(400, "This resource has no collection.");
		if (view === "customData" && !family.customData)
			return jsonError(400, "This resource has no metadata view.");
		const collections = childCollectionsFor(entry.kind);
		const key = parsed.data.collection;
		const child =
			key && collections && Object.hasOwn(collections, key)
				? collections[key]
				: undefined;
		if (
			key &&
			(!child ||
				(view === "childDetail" && !child.get) ||
				(view === "childMetadata" && !child.metadata))
		)
			return jsonError(400, "This muxing does not have this child view.");
		const api = resourceSdk(
			access,
			AbortSignal.any([req.signal, AbortSignal.timeout(15000)]),
			parsed.data.childId ?? address.id,
		);
		try {
			if (child) {
				const encodingId = address.parent("encodingId");
				const page = await readChildPage(api, child, encodingId, address.id, {
					offset,
					limit: pageSize,
				});
				if (view === "children") return respond(page);
				const id = parsed.data.childId;
				if (!id || !page.items.some((row) => row.id === id))
					return jsonError(
						409,
						"The child is no longer on the selected muxing page.",
					);
				if (view === "childDetail" && child.get)
					return respond({
						fields: await childFields(
							child.get,
							api,
							encodingId,
							address.id,
							id,
						),
					});
				if (view === "childMetadata" && child.metadata) {
					const value = object(
						(await child.metadata(api, encodingId, address.id, id)).customData,
					);
					if (!value) throw new InvalidResourceResponse();
					const executionId = "jobId" in owner ? owner.jobId : owner.channelId;
					return respond({
						fields: {
							keyCount: Object.keys(value).length,
							executionStamp: object(value.bitovp)?.job === executionId,
						},
					});
				}
			}
			if (view === "siblings" && family.list)
				return respond(
					await family.list(api, address, { offset, limit: pageSize }),
				);
			if (view === "customData" && family.customData) {
				const value = object(
					(await family.customData(api, address)).customData,
				);
				if (!value) throw new InvalidResourceResponse();
				const stamp = object(value.bitovp);
				const expectedStep = entry.attempt
					? `${entry.step}#${entry.attempt}`
					: entry.step;
				// Provider metadata can contain credentials or customer content. Only disclose counts and ownership.
				return respond({
					fields: {
						keyCount: Object.keys(value).length,
						executionStamp:
							!!stamp &&
							stamp.job ===
								("jobId" in owner ? owner.jobId : owner.channelId) &&
							stamp.step === expectedStep,
					},
				});
			}
			return respond({ fields: await family.detail(api, address) });
		} catch (err) {
			const status = object(err)?.httpStatusCode;
			if (status === 404)
				return jsonError(404, "The provider no longer has this resource.");
			return jsonError(
				502,
				err instanceof InvalidResourceResponse
					? "The provider returned an incomplete resource."
					: "The provider could not verify this resource.",
			);
		}
	} catch (err) {
		return routeError(err);
	}
}

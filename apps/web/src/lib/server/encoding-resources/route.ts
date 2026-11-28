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
import { acknowledgedCollectionIds } from "../confirmed-resource-ids";
import { getServerContext, type ServerContext } from "../context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "../http";
import { isAisaLiveChannelView } from "../live-channel-aisa-view";
import type { ChildDiscriminator } from "./child-collection";
import { diagnosticFor, inspectDiagnostic } from "./diagnostics";
import { InvalidResourceResponse, isResourceId } from "./family";
import {
	childCollectionsFor,
	findChildOnPage,
	readChildDetail,
	readChildPage,
} from "./resource-children";
import { removalAllowed } from "./retirement";
import { object, parseResourceLog, selectResource } from "./selection";
import {
	readEntireStreamFilterIds,
	recordedStreamFilters,
	streamFilterPath,
} from "./stream-filter-removal";

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
				"information",
				"siblings",
				"customData",
				"children",
				"childDetail",
				"childMetadata",
				"diagnostic",
				"childDiagnostic",
				"filterCollection",
			])
			.default("detail"),
		collection: z.string().min(1).max(48).optional(),
		diagnostic: z.string().min(1).max(48).optional(),
		childId: z.uuid().optional(),
		offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
	})
	.refine((input) => {
		const childView =
			input.view === "children" ||
			input.view === "childDetail" ||
			input.view === "childMetadata" ||
			input.view === "childDiagnostic";
		return (
			childView === !!input.collection &&
			!!input.diagnostic ===
				(input.view === "diagnostic" || input.view === "childDiagnostic") &&
			!!input.childId ===
				(input.view === "childDetail" ||
					input.view === "childMetadata" ||
					input.view === "childDiagnostic")
		);
	}, "Invalid child resource selection.");
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
	expected: {
		discriminator?: ChildDiscriminator;
		encodingId?: string;
		fixedDetailPath?: string;
		streamFilterPath?: string;
		streamFilterDeleteIds?: readonly string[];
		beforeStreamFilterDelete?: () => void;
	} = {},
) {
	// Typed endpoints can omit their discriminator. Check a supplied value before
	// the SDK maps it to a model and potentially substitutes the default type.
	const { discriminator, encodingId } = expected;
	const matchesBinding = (value: unknown) => {
		const model = object(value);
		if (!model) return false;
		if (discriminator) {
			const actual = model[discriminator.field];
			if (actual !== undefined && actual !== discriminator.value) return false;
		}
		return (
			!encodingId ||
			model.encodingId === undefined ||
			model.encodingId === encodingId
		);
	};
	return new BitmovinApi({
		apiKey: access.apiKey,
		...(access.tenantOrgId ? { tenantOrgId: access.tenantOrgId } : {}),
		fetch: async (url, init) => {
			const path = new URL(String(url)).pathname.replace(/\/$/, "");
			if (init?.method === "DELETE" && path === expected.streamFilterPath)
				expected.beforeStreamFilterDelete?.();
			const response = await fetch(url, { ...init, signal });
			if (!response.ok) return response;
			let body: unknown;
			try {
				body = await response.clone().json();
			} catch {
				throw new InvalidResourceResponse();
			}
			const envelope = object(body);
			const rawResult = object(envelope?.data)?.result;
			if (
				expected.streamFilterPath &&
				(path === expected.streamFilterPath ||
					path.startsWith(`${expected.streamFilterPath}/`))
			) {
				const result = object(rawResult);
				const isCollectionRead =
					init?.method === "GET" && path === expected.streamFilterPath;
				const isOneRemoval =
					init?.method === "DELETE" &&
					path === `${expected.streamFilterPath}/${String(result?.id ?? "")}` &&
					isResourceId(result?.id);
				const isCollectionRemoval =
					init?.method === "DELETE" &&
					path === expected.streamFilterPath &&
					expected.streamFilterDeleteIds !== undefined &&
					acknowledgedCollectionIds(rawResult, expected.streamFilterDeleteIds);
				if (
					envelope?.status !== "SUCCESS" ||
					!(isCollectionRead
						? Array.isArray(result?.filters)
						: isOneRemoval || isCollectionRemoval)
				)
					throw new InvalidResourceResponse();
				return response;
			}
			const result = object(rawResult);
			if (envelope?.status !== "SUCCESS" || !result)
				throw new InvalidResourceResponse();
			if (path.toLowerCase().endsWith("/customdata")) {
				if (
					!object(result.customData) ||
					(result.id !== undefined && result.id !== id)
				)
					throw new InvalidResourceResponse();
			} else if (path.endsWith(`/${encodeURIComponent(id)}/information`)) {
				// Information describes the addressed muxing and omits its ID.
				if (result.id !== undefined && result.id !== id)
					throw new InvalidResourceResponse();
			} else if (
				path === expected.fixedDetailPath ||
				path.endsWith(`/${encodeURIComponent(id)}`)
			) {
				if (result.id !== id || !matchesBinding(result))
					throw new InvalidResourceResponse();
			} else if (
				!Array.isArray(result.items) ||
				typeof result.totalCount !== "number" ||
				((discriminator || encodingId) && !result.items.every(matchesBinding))
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
	const values = Object.fromEntries(params);
	if (params.size !== Object.keys(values).length)
		return jsonError(400, "Duplicate resource query parameter.");
	const parsed = params.size ? query.safeParse(values) : null;
	if (parsed && !parsed.success) return validationError(parsed.error);
	try {
		const ctx = await getServerContext();
		const live = !("jobId" in owner);
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
					const s = selectResource(log, step, live)?.summary;
					return s
						? [
								{
									...s,
									retainedForPublication: row.retainedOutputIds.has(s.id),
									...(!live &&
										s.kind === "CREATE_STREAM" &&
										[...log.steps.values()].some(
											(entry) =>
												entry.kind === "CREATE_STREAM_FILTERS" &&
												entry.status === "DONE" &&
												entry.refs.streamId === s.step,
										) && { hasFilterCollection: true }),
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
		const filterCollection =
			view === "filterCollection" ? recordedStreamFilters(log, selected) : null;
		if (view === "filterCollection") {
			if (!mayRemove(ctx)) return jsonError(403, "Operator access required.");
			if (!("jobId" in owner) || !row.removable || !filterCollection)
				return jsonError(
					409,
					"This stream's filter attachments cannot be verified.",
				);
			selected.parentScopes.push(...filterCollection.scopes);
		}
		const access = await originalAccess(ctx, row, selected);
		if (!access)
			return jsonError(
				409,
				"The resource's original provider account cannot be verified.",
			);
		if (view === "siblings" && !family.list)
			return jsonError(400, "This resource has no collection.");
		if (view === "information" && !family.information)
			return jsonError(400, "This resource has no output information view.");
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
				(child.liveOnly && !live) ||
				(view === "childDetail" && !child.get) ||
				(view === "childMetadata" && !child.metadata))
		)
			return jsonError(400, "This resource does not have this child view.");
		const diagnosticKey = parsed.data.diagnostic;
		const diagnostic = diagnosticKey
			? diagnosticFor(entry.kind, diagnosticKey, key, family, live)
			: undefined;
		if (diagnosticKey && !diagnostic)
			return jsonError(400, "This resource does not have this diagnostic.");
		const signal = AbortSignal.any([req.signal, AbortSignal.timeout(15000)]);
		const page = { offset, limit: pageSize };
		const childId = parsed.data.childId;
		try {
			if ("jobId" in owner && filterCollection) {
				const pending = await ctx.prisma.encodingResourceRemoval.findFirst({
					where: {
						pendingJobId: owner.jobId,
						providerId: address.id,
						attempt,
						step: { startsWith: `${step}:filters:collection:` },
						state: { in: ["SENDING", "UNKNOWN"] },
					},
					select: { id: true },
				});
				const api = resourceSdk(access, signal, address.id, {
					streamFilterPath: streamFilterPath(address),
				});
				const filterIds = await readEntireStreamFilterIds(api, address);
				const blocked = filterIds.some(
					(id) => !filterCollection.ids.includes(id),
				);
				return respond({
					filterIds: blocked ? [] : filterIds,
					blocked,
					pending: !!pending,
				});
			}
			if (view === "diagnostic" && diagnostic)
				return respond(
					await inspectDiagnostic(
						diagnostic,
						{ address, id: address.id, page },
						access,
						signal,
					),
				);
			const api = resourceSdk(access, signal, childId ?? address.id, {
				fixedDetailPath: childId
					? undefined
					: family.fixedDetailPath?.(address),
				discriminator: child
					? child.expectedDiscriminator
					: family.expectedDiscriminator,
				encodingId: child?.encodingScope ? address.id : undefined,
			});
			if (child) {
				if (view === "children")
					return respond(await readChildPage(api, child, address, page));
				const id = childId;
				const member =
					id && (await findChildOnPage(api, child, address, page, id));
				if (!id || !member)
					return jsonError(
						409,
						"The child is no longer on the selected resource page.",
					);
				if (view === "childDetail")
					return respond({
						fields: await readChildDetail(api, child, address, id),
					});
				if (view === "childDiagnostic" && diagnostic)
					return respond(
						await inspectDiagnostic(
							diagnostic,
							{ address, id, page, listedType: member.type },
							access,
							signal,
						),
					);
				if (view === "childMetadata" && child.metadata) {
					const value = object(
						(await child.metadata(api, address, id)).customData,
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
			if (view === "information" && family.information)
				return respond({ fields: await family.information(api, address) });
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
				return jsonError(
					404,
					view === "information"
						? "The provider has no output information for this resource."
						: "The provider no longer has this resource.",
				);
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

import "server-only";
import { randomUUID } from "node:crypto";
import type { AppTransactionClient } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "../audit";
import { getServerContext, type ServerContext } from "../context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "../http";
import { removalAllowed } from "./retirement";
import {
	mayRemove,
	originalAccess,
	type ResourceOwner,
	recordedScopeMatches,
	resourceSdk,
	resourceSource,
} from "./route";
import { object, parseResourceLog, selectResource } from "./selection";

const commandSchema = z.strictObject({
	step: z.string().min(1).max(512),
	attempt: z.number().int().nonnegative(),
	confirmResourceId: z.string().min(1).max(512),
	retry: z.boolean().optional(),
});
type Command = z.infer<typeof commandSchema>;
type Access = NonNullable<Awaited<ReturnType<typeof originalAccess>>>;
type Action = "remove" | "verify";
class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
async function lookup(
	ctx: ServerContext,
	owner: ResourceOwner,
	cmd: Command,
	db = ctx.prisma as Pick<
		AppTransactionClient,
		"encodingJob" | "liveChannelRun"
	>,
) {
	const source = await resourceSource(ctx, owner, db);
	if (!source) throw new Refusal(404, "Execution not found.");
	const history = parseResourceLog(source.stepLog);
	const selected = history && selectResource(history, cmd.step);
	if (!selected) throw new Refusal(404, "Recorded resource not found.");
	if (
		selected.address.id !== cmd.confirmResourceId ||
		selected.summary.attempt !== cmd.attempt
	)
		throw new Refusal(
			409,
			"The selected resource changed. Refresh the execution.",
		);
	if (history?.ids.get(selected.address.id)?.length !== 1)
		throw new Refusal(409, "The resource has multiple recorded owners.");
	return { source, selected };
}
async function reserve(
	ctx: ServerContext,
	owner: ResourceOwner,
	cmd: Command,
	access: Access,
	action: Action,
) {
	return ctx.prisma.$transaction(async (tx) => {
		const [account] = await tx.$queryRaw<
			{ id: string }[]
		>`SELECT id FROM "BitmovinAccount" WHERE id=${access.id}::uuid AND "resourceScopeVersion"=${access.resourceScopeVersion}::uuid FOR SHARE`;
		if (!account)
			throw new Refusal(409, "The original provider account changed.");
		const job = "jobId" in owner;
		const sourceKind = job ? "VOD" : "LIVE";
		const sourceId = job ? owner.jobId : owner.runId;
		if (job) {
			await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id=${sourceId}::uuid FOR UPDATE`;
		} else {
			await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id=${owner.channelId}::uuid FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id=${sourceId}::uuid AND "liveChannelId"=${owner.channelId}::uuid FOR UPDATE`;
		}
		const { source, selected } = await lookup(ctx, owner, cmd, tx);
		if (!recordedScopeMatches(source, selected, access))
			throw new Refusal(409, "The recorded provider account changed.");
		const providerId = selected.address.id;
		const key = {
			sourceKind,
			sourceId,
			step: cmd.step,
			attempt: cmd.attempt,
			providerId,
		};
		const prior = await tx.encodingResourceRemoval.findFirst({ where: key });
		if (
			prior &&
			(prior.accountId !== access.id ||
				prior.scopeVersion !== access.resourceScopeVersion)
		)
			throw new Refusal(
				409,
				"The removal belongs to another provider account scope.",
			);
		if (prior?.state === "REMOVED") return { done: true as const };
		if (action === "verify" && (!prior || prior.state === "REFUSED"))
			throw new Refusal(409, "There is no pending removal to verify.");
		if (
			prior?.state === "SENDING" &&
			Date.now() - prior.updatedAt.getTime() < 60_000
		)
			throw new Refusal(409, "The removal is still in progress.");
		if (action === "remove" && prior && !cmd.retry)
			throw new Refusal(409, "Check the previous removal before retrying.");
		if (action === "remove") {
			if (source.retainedOutputIds.has(providerId))
				throw new Refusal(
					409,
					"This output is retained for Live-to-VOD publication.",
				);
			if (!(await removalAllowed(tx, owner, source.removable)))
				throw new Refusal(
					409,
					"Stop this execution and confirm its provider state before removing a resource.",
				);
			const [check] = await tx.$queryRaw<
				{ exclusive: boolean }[]
			>`SELECT bitovp_resource_exclusive(${sourceKind}::text,${sourceId}::uuid,${cmd.step}::text,${cmd.attempt}::integer,${providerId}::text,${access.id}::uuid) AS exclusive`;
			if (!check?.exclusive)
				throw new Refusal(
					409,
					"The service cannot verify exclusive ownership of this resource.",
				);
		}
		const token = randomUUID();
		const pending = {
			pendingJobId: job ? sourceId : null,
			pendingRunId: job ? null : sourceId,
		};
		const state = { state: "SENDING", token, ...pending };
		const claim = prior
			? await tx.encodingResourceRemoval.update({
					where: { id: prior.id, token: prior.token },
					data: state,
					select: { id: true },
				})
			: await tx.encodingResourceRemoval.create({
					data: {
						...key,
						...state,
						channelId: job ? null : owner.channelId,
						accountId: access.id,
						scopeVersion: access.resourceScopeVersion,
					},
					select: { id: true },
				});
		return {
			done: false as const,
			id: claim.id,
			token,
			selected,
			uncertain: prior?.state === "UNKNOWN" || prior?.state === "SENDING",
		};
	});
}

export async function removeResource(
	req: Request,
	owner: ResourceOwner,
	action: Action,
) {
	for (const id of Object.values(owner)) {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
	}
	const parsed = commandSchema.safeParse(await readJson(req));
	if (!parsed.success) return validationError(parsed.error);
	try {
		const ctx = await getServerContext();
		if (!mayRemove(ctx)) return jsonError(403, "Operator access required.");
		const cmd = parsed.data;
		const { source, selected } = await lookup(ctx, owner, cmd);
		const access = await originalAccess(ctx, source, selected);
		if (!access)
			return jsonError(
				409,
				"The resource's original provider account cannot be verified.",
			);
		const claim = await reserve(ctx, owner, cmd, access, action);
		if (claim.done)
			return NextResponse.json({ state: "REMOVED", disposition: "recorded" });
		const { family, address } = claim.selected;
		const api = resourceSdk(access, AbortSignal.timeout(15_000), address.id);
		let state: "REFUSED" | "UNKNOWN" | "REMOVED" = "UNKNOWN";
		let disposition: "removed" | "absent" | "present" | "unknown" | "refused" =
			"unknown";
		let sent = false;
		try {
			await family.detail(api, address);
			if (action === "verify") {
				disposition = "present";
			} else {
				sent = true;
				await family.remove(api, address);
				state = "REMOVED";
				disposition = "removed";
			}
		} catch (err) {
			const e = object(err);
			if (e?.httpStatusCode === 404 && e.errorCode === 1001) {
				state = "REMOVED";
				disposition = "absent";
			} else if (
				!claim.uncertain &&
				action === "remove" &&
				(!sent || [400, 401, 403, 409, 422].includes(Number(e?.httpStatusCode)))
			) {
				state = "REFUSED";
				disposition = "refused";
			}
		}
		const resolved = state !== "UNKNOWN";
		const { count } = await ctx.prisma.encodingResourceRemoval.updateMany({
			where: { id: claim.id, token: claim.token, state: "SENDING" },
			data: {
				state,
				...(resolved ? { pendingJobId: null, pendingRunId: null } : {}),
			},
		});
		if (count !== 1)
			return jsonError(
				409,
				"The recorded removal changed. Reload the execution.",
			);
		const status =
			state === "REMOVED" || disposition === "present"
				? 200
				: state === "REFUSED"
					? 409
					: 502;
		await writeAuditLog(
			ctx,
			{
				method: req.method,
				path: new URL(req.url).pathname,
				bitmovinAccountId: access.id,
				request: {
					step: cmd.step,
					attempt: cmd.attempt,
					resourceId: address.id,
				},
				response: { state, disposition },
				statusCode: status,
			},
			req,
		);
		return NextResponse.json(
			{
				state,
				disposition,
				...(status >= 400
					? {
							error:
								state === "REFUSED"
									? "The provider refused the removal."
									: "Removal could not be confirmed. Check provider state before retrying.",
						}
					: {}),
			},
			{ status, headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (e) {
		if (e instanceof Refusal) return jsonError(e.status, e.message);
		return routeError(e);
	}
}

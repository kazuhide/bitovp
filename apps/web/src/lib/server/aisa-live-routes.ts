import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type AisaAnalysis,
	aisaActionBodySchema,
	aisaAnalysisSchema,
	aisaCreateBodySchema,
	aisaIngestSchema,
	aisaResultSchema,
} from "@/lib/aisa-live/contracts";
import { listQuerySchema } from "@/lib/infrastructure/schemas";
import { aisaLiveAccessAllowed } from "./aisa-live-access";
import {
	AisaLiveError,
	aisaLiveClientForAccount,
	aisaLivePreviewEnabled,
} from "./aisa-live-sdk";
import { writeAuditLog } from "./audit";
import { getServerContext, type ServerContext } from "./context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "./http";

const accountQuery = z.object({ bitmovinAccountId: z.uuid() });
const pageSchema = z.object({
	items: z.array(aisaAnalysisSchema).max(100),
	totalCount: z.number().int().nonnegative().optional(),
	offset: z.number().int().nonnegative().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

function json(value: unknown, status = 200) {
	return NextResponse.json(value, { status });
}

/** Every response is private, including errors and credential-bearing ingest reads. */
async function handle(
	run: (ctx: ServerContext) => Promise<Response>,
): Promise<Response> {
	let response: Response;
	try {
		if (!aisaLivePreviewEnabled()) response = jsonError(404, "Not found");
		else {
			const ctx = await getServerContext();
			response = aisaLiveAccessAllowed(ctx.tenant)
				? await run(ctx)
				: jsonError(404, "Not found");
		}
	} catch (error) {
		if (error instanceof AisaLiveError) {
			const status = [404, 409, 422, 503].includes(error.httpStatusCode)
				? error.httpStatusCode
				: 502;
			response = jsonError(
				status,
				"AISA Live request could not be completed.",
				{
					code: error.code ?? "AISA_LIVE_UPSTREAM_UNAVAILABLE",
				},
			);
		} else {
			response = routeError(error);
		}
	}
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

async function scope(
	ctx: ServerContext,
	accountId: string,
	versions?: { esVersion?: string; aicaVersion?: string },
) {
	const client = await aisaLiveClientForAccount(ctx, accountId, versions);
	return client ? { ctx, client } : null;
}

function query(req: Request) {
	return Object.fromEntries(new URL(req.url).searchParams);
}

function analysis(
	raw: unknown,
	id?: string,
	encodingId?: string,
): AisaAnalysis {
	const parsed = aisaAnalysisSchema.safeParse(raw);
	if (
		!parsed.success ||
		(id && parsed.data.analysisId !== id) ||
		(encodingId && parsed.data.encodingId !== encodingId)
	) {
		throw new AisaLiveError(502);
	}
	return parsed.data;
}

/** Do not retry writes: a lost response may follow a successful paid operation. */
async function mutate(options: {
	req: Request;
	ctx: ServerContext;
	accountId: string;
	path: string;
	request: Record<string, unknown>;
	status?: number;
	call: () => Promise<AisaAnalysis>;
}) {
	const started = Date.now();
	let result: AisaAnalysis;
	try {
		result = await options.call();
	} catch (error) {
		await writeAuditLog(
			options.ctx,
			{
				method: "POST",
				path: options.path,
				bitmovinAccountId: options.accountId,
				request: options.request,
				statusCode: error instanceof AisaLiveError ? error.httpStatusCode : 500,
				durationMs: Date.now() - started,
				error:
					"AISA Live operation could not be confirmed; refresh the resource before retrying.",
			},
			options.req,
		);
		throw error;
	}
	await writeAuditLog(
		options.ctx,
		{
			method: "POST",
			path: options.path,
			bitmovinAccountId: options.accountId,
			request: options.request,
			response: {
				analysisId: result.analysisId,
				encodingId: result.encodingId,
				status: result.status,
			},
			statusCode: options.status ?? 200,
			durationMs: Date.now() - started,
		},
		options.req,
	);
	return json(result, options.status ?? 200);
}

export function aisaList(req: Request) {
	return handle(async (ctx) => {
		const parsed = listQuerySchema.safeParse(query(req));
		if (!parsed.success) return validationError(parsed.error);
		const scoped = await scope(ctx, parsed.data.bitmovinAccountId);
		if (!scoped) return jsonError(404, "Bitmovin account not found");
		const page = pageSchema.safeParse(
			await scoped.client.list({
				offset: parsed.data.offset,
				limit: parsed.data.limit,
			}),
		);
		if (!page.success) throw new AisaLiveError(502);
		return json(page.data);
	});
}

export function aisaCreate(req: Request) {
	return handle(async (ctx) => {
		const parsed = aisaCreateBodySchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const { bitmovinAccountId, analysis: config } = parsed.data;
		const scoped = await scope(ctx, bitmovinAccountId);
		if (!scoped) return jsonError(404, "Bitmovin account not found");
		return mutate({
			req,
			ctx: scoped.ctx,
			accountId: bitmovinAccountId,
			path: "/ai-scene-analysis/live-analyses",
			status: 201,
			// Source URLs and stream keys can carry credentials; audit presence only.
			request: {
				inputType: config.input.type,
				recordingOutputCount: config.recording.outputs.length,
				analysisOutputCount: config.outputs.length,
			},
			call: async () => analysis(await scoped.client.create(config)),
		});
	});
}

export function aisaDetail(req: Request, id: string) {
	return handle(async (ctx) => {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const parsed = accountQuery.safeParse(query(req));
		if (!parsed.success) return validationError(parsed.error);
		const scoped = await scope(ctx, parsed.data.bitmovinAccountId);
		if (!scoped) return jsonError(404, "Bitmovin account not found");
		return json(analysis(await scoped.client.get(id), id));
	});
}

export function aisaAction(req: Request, id: string) {
	return handle(async (ctx) => {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const parsed = aisaActionBodySchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const { bitmovinAccountId, action, esVersion, aicaVersion } = parsed.data;
		const versions =
			action === "start"
				? {
						...(esVersion ? { esVersion } : {}),
						...(aicaVersion ? { aicaVersion } : {}),
					}
				: undefined;
		const scoped = await scope(ctx, bitmovinAccountId, versions);
		if (!scoped) return jsonError(404, "Bitmovin account not found");
		const managedRun = await scoped.ctx.prisma.liveChannelRun.findFirst({
			where: { aisaAnalysisId: id, liveChannel: { bitmovinAccountId } },
			select: { id: true },
		});
		if (managedRun)
			return jsonError(
				409,
				"Use the channel's live controls for this analysis",
				{ code: "AISA_CHANNEL_CONTROLS_REQUIRED" },
			);
		const current = analysis(await scoped.client.get(id), id);
		const allowed =
			action === "start"
				? current.status === "CREATED"
				: current.status === "QUEUED" || current.status === "RUNNING";
		if (!allowed)
			return jsonError(
				409,
				"This action is unavailable in the current Analysis state.",
			);
		return mutate({
			req,
			ctx: scoped.ctx,
			accountId: bitmovinAccountId,
			path: `/ai-scene-analysis/live-analyses/${id}/${action}`,
			request: {
				action,
				esVersionProvided: Boolean(esVersion),
				aicaVersionProvided: Boolean(aicaVersion),
			},
			call: async () =>
				analysis(await scoped.client[action](id), id, current.encodingId),
		});
	});
}

export function aisaResults(req: Request, id: string) {
	return handle(async (ctx) => {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const parsed = accountQuery.safeParse(query(req));
		if (!parsed.success) return validationError(parsed.error);
		const scoped = await scope(ctx, parsed.data.bitmovinAccountId);
		if (!scoped) return jsonError(404, "Bitmovin account not found");
		const current = analysis(await scoped.client.get(id), id);
		let raw: unknown;
		try {
			raw = await scoped.client.latest(id);
		} catch (error) {
			if (
				error instanceof AisaLiveError &&
				error.httpStatusCode === 404 &&
				error.code === "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE"
			)
				return json({ availability: "pending" });
			throw error;
		}
		const result = aisaResultSchema.safeParse(raw);
		if (
			!result.success ||
			result.data.analysisId !== id ||
			result.data.encodingId !== current.encodingId
		) {
			throw new AisaLiveError(502);
		}
		return json({ availability: "available", snapshot: result.data });
	});
}

/** The proxy retains an OPERATOR floor; the owner policy protects every dedicated read. */
export function aisaIngest(req: Request, id: string) {
	return handle(async (ctx) => {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const parsed = accountQuery
			.extend({ encodingId: z.uuid().optional() })
			.safeParse(query(req));
		if (!parsed.success) return validationError(parsed.error);
		const scoped = await scope(ctx, parsed.data.bitmovinAccountId);
		if (!scoped) return jsonError(404, "Bitmovin account not found");
		const raw = await scoped.client.get(id);
		const current = analysis(raw, id);
		if (
			parsed.data.encodingId &&
			current.encodingId !== parsed.data.encodingId
		) {
			return jsonError(409, "The analysis does not match this run", {
				code: "AISA_LIVE_IDENTITY_MISMATCH",
			});
		}
		if (current.status !== "RUNNING") return json({});
		const ingest = aisaIngestSchema.safeParse(raw);
		if (!ingest.success) throw new AisaLiveError(502);
		return json(ingest.data);
	});
}

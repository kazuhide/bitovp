import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type AisaResultSnapshot,
	aisaAnalysisSchema,
	aisaResultSchema,
} from "@/lib/aisa-live/contracts";
import {
	AISA_TRANSLATION_PROMPT_VERSION,
	type AisaTranslation,
	aisaTranslationBodySchema,
	aisaTranslationSchema,
} from "@/lib/aisa-live/translations";
import { AuthContextError } from "@/lib/auth/tenancy";
import {
	AisaLiveError,
	aisaLiveClientForAccount,
	aisaLivePreviewEnabled,
} from "./aisa-live-sdk";
import {
	AisaTranslationError,
	probeAisaTranslationEngine,
	readAisaTranslationEngineConfig,
	translateAisaObservations,
} from "./aisa-live-translations-engine";
import { writeAuditLog } from "./audit";
import { getServerContext, type ServerContext } from "./context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "./http";

const querySchema = z.strictObject({ bitmovinAccountId: z.uuid() });
const storedSchema = z.strictObject({
	version: z.literal(1),
	accountId: z.uuid(),
	analysisId: z.uuid(),
	encodingId: z.uuid(),
	translation: aisaTranslationSchema,
});
type Store = Pick<ServerContext["prisma"], "appSetting">;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const keyFor = (
	accountId: string,
	snapshot: AisaResultSnapshot,
	observationId: string,
) =>
	`aisa-live.translation.v1:${accountId}:${snapshot.analysisId}:${snapshot.encodingId}:${hash(observationId)}`;
const pending = new Map<string, Promise<void>>();
let inferenceBusy = false;

async function handle(run: () => Promise<Response>): Promise<Response> {
	let response: Response;
	try {
		response = aisaLivePreviewEnabled()
			? await run()
			: jsonError(404, "Not found");
	} catch (error) {
		if (error instanceof AuthContextError) response = routeError(error);
		else if (error instanceof AisaTranslationError)
			response = jsonError(error.status, "AISA translation unavailable.", {
				code: error.code,
			});
		else if (error instanceof AisaLiveError)
			response = jsonError(
				[404, 409, 503].includes(error.httpStatusCode)
					? error.httpStatusCode
					: 502,
				"AISA analysis unavailable.",
			);
		else response = jsonError(500, "AISA translation unavailable.");
	}
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

async function load(accountId: string, id: string) {
	const ctx = await getServerContext();
	const client = await aisaLiveClientForAccount(ctx, accountId);
	if (!client)
		throw new AisaTranslationError("AISA_TRANSLATION_ACCOUNT_UNAVAILABLE", 404);
	const current = aisaAnalysisSchema.safeParse(await client.get(id));
	if (!current.success || current.data.analysisId !== id)
		throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_INVALID", 502);
	const snapshot = aisaResultSchema.safeParse(await client.latest(id));
	if (
		!snapshot.success ||
		snapshot.data.analysisId !== id ||
		snapshot.data.encodingId !== current.data.encodingId
	)
		throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_INVALID", 502);
	if (snapshot.data.observations.length > 2_000)
		throw new AisaTranslationError("AISA_TRANSLATION_INPUT_LIMIT", 422);
	return { ctx, client, snapshot: snapshot.data };
}

async function retained(
	store: Store,
	accountId: string,
	snapshot: AisaResultSnapshot,
	model?: string,
) {
	const observations = new Map(
		snapshot.observations.map((item) => [item.id, item]),
	);
	if (!observations.size) return [];
	const rows = await store.appSetting.findMany({
		where: {
			key: {
				in: [...observations.keys()].map((id) =>
					keyFor(accountId, snapshot, id),
				),
			},
		},
		select: { key: true, value: true },
	});
	const valid: AisaTranslation[] = [];
	for (const row of rows) {
		const parsed = storedSchema.safeParse(row.value);
		if (!parsed.success) continue;
		const record = parsed.data;
		const entry = record.translation;
		const source = observations.get(entry.observationId);
		if (
			record.accountId !== accountId ||
			record.analysisId !== snapshot.analysisId ||
			record.encodingId !== snapshot.encodingId ||
			row.key !== keyFor(accountId, snapshot, entry.observationId) ||
			!source ||
			source.text !== entry.sourceText ||
			hash(source.text) !== entry.sourceTextHash ||
			(entry.origin === "LOCAL_MODEL" && model && entry.model !== model)
		)
			continue;
		valid.push(entry);
	}
	return valid;
}

function engineConfig() {
	try {
		return readAisaTranslationEngineConfig();
	} catch {
		return undefined;
	}
}

async function responseFor(
	store: Store,
	accountId: string,
	snapshot: AisaResultSnapshot,
) {
	const config = engineConfig();
	return NextResponse.json({
		analysisId: snapshot.analysisId,
		encodingId: snapshot.encodingId,
		targetLanguage: "ja",
		automatic: {
			available: await probeAisaTranslationEngine(config),
			provider: config ? "LOCAL_OPENAI_COMPATIBLE" : null,
			model: config?.model ?? null,
		},
		translations: await retained(store, accountId, snapshot, config?.model),
	});
}

async function persist(
	ctx: ServerContext,
	accountId: string,
	snapshot: AisaResultSnapshot,
	entries: AisaTranslation[],
) {
	await ctx.prisma.$transaction(
		async (tx) => {
			const previous = await retained(tx, accountId, snapshot);
			for (const entry of entries) {
				// A late model result must never replace a current operator-authored translation.
				if (
					entry.origin === "LOCAL_MODEL" &&
					previous.some(
						(item) =>
							item.observationId === entry.observationId &&
							item.origin === "MANUAL",
					)
				)
					continue;
				const key = keyFor(accountId, snapshot, entry.observationId);
				const value = {
					version: 1,
					accountId,
					analysisId: snapshot.analysisId,
					encodingId: snapshot.encodingId,
					translation: entry,
				};
				await tx.appSetting.upsert({
					where: { key },
					create: { key, value },
					update: { value },
				});
			}
		},
		{ isolationLevel: "Serializable" },
	);
}

function sameSources(
	before: AisaResultSnapshot,
	after: AisaResultSnapshot,
	ids: string[],
) {
	if (
		before.analysisId !== after.analysisId ||
		before.encodingId !== after.encodingId ||
		after.sequence < before.sequence
	)
		throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_CHANGED", 409);
	const current = new Map(
		after.observations.map((item) => [item.id, item.text]),
	);
	const original = new Map(
		before.observations.map((item) => [item.id, item.text]),
	);
	if (
		ids.some((id) => !current.has(id) || current.get(id) !== original.get(id))
	)
		throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_CHANGED", 409);
}

export function aisaTranslationsGet(req: Request, id: string) {
	return handle(async () => {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const parsed = querySchema.safeParse(
			Object.fromEntries(new URL(req.url).searchParams),
		);
		if (!parsed.success) return validationError(parsed.error);
		const { ctx, snapshot } = await load(parsed.data.bitmovinAccountId, id);
		return responseFor(ctx.prisma, parsed.data.bitmovinAccountId, snapshot);
	});
}

export function aisaTranslationsPost(req: Request, id: string) {
	return handle(async () => {
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const parsed = aisaTranslationBodySchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const body = parsed.data;
		const { bitmovinAccountId: accountId } = body;
		const { ctx, snapshot } = await load(accountId, id);
		if (body.encodingId !== snapshot.encodingId)
			throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_CHANGED", 409);
		const sources = new Map(
			snapshot.observations.map((item) => [item.id, item]),
		);
		const sourceFor = (sourceId: string) => {
			const source = sources.get(sourceId);
			if (!source)
				throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_CHANGED", 409);
			return source;
		};
		const ids =
			body.action === "save"
				? body.translations.map((item) => item.observationId)
				: body.observationIds;
		if (ids.some((observationId) => !sources.has(observationId)))
			throw new AisaTranslationError("AISA_TRANSLATION_SOURCE_CHANGED", 409);
		if (body.action === "save") {
			const entries = body.translations.map((item) => {
				const source = sourceFor(item.observationId);
				if (
					source.text !== item.sourceText ||
					hash(source.text) !== item.sourceTextHash
				)
					throw new AisaTranslationError(
						"AISA_TRANSLATION_SOURCE_CHANGED",
						409,
					);
				return aisaTranslationSchema.parse({
					...item,
					targetLanguage: "ja",
					origin: "MANUAL",
					provider: "OPERATOR",
					model: null,
					promptVersion: null,
					sourceSequence: snapshot.sequence,
					createdAt: new Date().toISOString(),
				});
			});
			await persist(ctx, accountId, snapshot, entries);
		} else {
			const config = readAisaTranslationEngineConfig();
			if (!config)
				throw new AisaTranslationError("AISA_TRANSLATION_NOT_CONFIGURED");
			const existing = await retained(
				ctx.prisma,
				accountId,
				snapshot,
				config.model,
			);
			const missing = ids.filter(
				(observationId) =>
					!existing.some((entry) => entry.observationId === observationId),
			);
			if (missing.length) {
				const organizationId = ctx.tenant?.organizationId;
				if (!organizationId)
					throw new AisaTranslationError(
						"AISA_TRANSLATION_SCOPE_UNAVAILABLE",
						500,
					);
				const key = hash(
					JSON.stringify([
						organizationId,
						accountId,
						id,
						snapshot.encodingId,
						config.model,
						AISA_TRANSLATION_PROMPT_VERSION,
						missing
							.map((sourceId) => [sourceId, hash(sourceFor(sourceId).text)])
							.sort(),
					]),
				);
				let work = pending.get(key);
				if (!work) {
					if (inferenceBusy)
						throw new AisaTranslationError("AISA_TRANSLATION_BUSY", 429);
					inferenceBusy = true;
					work = Promise.resolve()
						.then(async () => {
							const translated = await translateAisaObservations(
								config,
								missing.map((sourceId) => ({
									id: sourceId,
									text: sourceFor(sourceId).text,
								})),
								fetch,
								organizationId,
							);
							const fresh = await load(accountId, id);
							sameSources(snapshot, fresh.snapshot, missing);
							const entries = translated.map((item) =>
								aisaTranslationSchema.parse({
									observationId: item.id,
									sourceText: sourceFor(item.id).text,
									sourceTextHash: hash(sourceFor(item.id).text),
									text: item.text,
									targetLanguage: "ja",
									sourceSequence: snapshot.sequence,
									origin: "LOCAL_MODEL",
									provider: "LOCAL_OPENAI_COMPATIBLE",
									model: config.model,
									promptVersion: AISA_TRANSLATION_PROMPT_VERSION,
									createdAt: new Date().toISOString(),
								}),
							);
							await persist(ctx, accountId, fresh.snapshot, entries);
						})
						.finally(() => {
							pending.delete(key);
							inferenceBusy = false;
						});
					pending.set(key, work);
				}
				await work;
			}
		}
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: `/api/live/analyses/${id}/translations`,
				bitmovinAccountId: accountId,
				request: { action: body.action, observationCount: ids.length },
				statusCode: 200,
			},
			req,
		);
		const fresh = await load(accountId, id);
		return responseFor(ctx.prisma, accountId, fresh.snapshot);
	});
}

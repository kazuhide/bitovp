import { createHash, randomUUID } from "node:crypto";
import {
	librarySnapshotSchema,
	MAX_SCENE_ANALYSIS_BYTES,
	normalizeSceneAnalysis,
	redactSecrets,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { UnsupportedBrowseError } from "@bitovp/storage";
import { BitmovinApi } from "../bitmovin/sdk-ctor";
import type { createStoredAnalysisReader } from "./stored-analysis";

export const ANALYSIS_SWEEP_INTERVAL_MS = 10_000;
export const ANALYSIS_LEASE_MS = 120_000;
export const ANALYSIS_MAX_ATTEMPTS = 5;
type Provider = { get(encodingId: string, locale: string): Promise<unknown> };

export function createAnalysisProvider(deps: {
	revealBitmovinAccount(
		id: string,
	): Promise<{ apiKey: string; tenantOrgId: string | null }>;
}) {
	return async (id: string): Promise<Provider> => {
		const account = await deps.revealBitmovinAccount(id);
		let rawResult: unknown;
		const api = new BitmovinApi({
			apiKey: account.apiKey,
			...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
			fetch: async (url: string, init?: RequestInit) => {
				const response = await fetch(url, {
					...init,
					signal: AbortSignal.timeout(25_000),
				});
				// Bound bytes before the SDK JSON parser allocates a provider payload.
				const reader = response.body?.getReader();
				if (!reader) return response;
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > MAX_SCENE_ANALYSIS_BYTES)
							throw new Error("Analysis response exceeds 8 MiB");
						chunks.push(value);
					}
				} finally {
					await reader.cancel();
				}
				const body = Buffer.concat(chunks);
				if (response.ok) {
					const envelope = JSON.parse(body.toString("utf8"));
					rawResult = envelope?.data?.result;
				}
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			},
		});
		return {
			get: async (encodingId, locale) => {
				// Let the SDK validate status/envelope, retaining fields its model mapper drops.
				rawResult = undefined;
				await api.aiSceneAnalysis.analyses.byEncodingId.details.language.get(
					encodingId,
					locale,
				);
				return rawResult;
			},
		};
	};
}

/** DB request rows are the work queue. No writes to the VOD lifecycle or provider. */
export function createAnalysisSweep(deps: {
	prisma: AppPrismaClient;
	providerFor(accountId: string): Promise<Provider>;
	readOutput?: ReturnType<typeof createStoredAnalysisReader>;
	now?: () => Date;
	uuid?: () => string;
}) {
	const now = deps.now ?? (() => new Date());
	return async () => {
		const current = now();
		const eligible = {
			attempts: { lt: ANALYSIS_MAX_ATTEMPTS },
			OR: [
				{ state: { in: ["PENDING", "ERROR"] }, availableAt: { lte: current } },
				{ state: "RUNNING", leaseUntil: { lte: current } },
			],
		};
		// A crash during the final attempt must still reach a visible terminal error.
		await deps.prisma.librarySource.updateMany({
			where: {
				state: "RUNNING",
				attempts: { gte: ANALYSIS_MAX_ATTEMPTS },
				leaseUntil: { lte: current },
			},
			data: {
				state: "ERROR",
				leaseToken: null,
				leaseUntil: null,
				error: "Analysis import attempts exhausted",
			},
		});
		const rows = await deps.prisma.librarySource.findMany({
			where: eligible,
			orderBy: { availableAt: "asc" },
			take: 5,
			select: {
				id: true,
				encodingId: true,
				accountId: true,
				locales: true,
				attempts: true,
				snapshot: true,
			},
		});
		for (const row of rows) {
			const leaseToken = (deps.uuid ?? randomUUID)();
			const claimed = await deps.prisma.librarySource.updateMany({
				where: { id: row.id, ...eligible },
				data: {
					state: "RUNNING",
					leaseToken,
					leaseUntil: new Date(now().getTime() + ANALYSIS_LEASE_MS),
					attempts: { increment: 1 },
					error: null,
				},
			});
			if (!claimed.count) continue;
			const fence = () => ({
				id: row.id,
				state: "RUNNING",
				leaseToken,
				leaseUntil: { gt: now() },
			});
			let failed = false;
			try {
				const present = await deps.prisma.sceneAnalysisRevision.findMany({
					where: { sourceId: row.id },
					select: { locale: true },
					distinct: ["locale"],
				});
				const completed = new Set(present.map((item) => item.locale));
				const output = librarySnapshotSchema.safeParse(row.snapshot);
				const locator = output.success ? output.data.analysisOutput : undefined;
				let provider: Provider | undefined;
				const read = async (locale: string) => {
					if (locator && deps.readOutput) {
						try {
							return await deps.readOutput(locator, locale);
						} catch (error) {
							if (!(error instanceof UnsupportedBrowseError)) throw error;
						}
					}
					provider ??= await deps.providerFor(row.accountId);
					return provider.get(row.encodingId, locale);
				};
				for (const locale of row.locales) {
					if (completed.has(locale)) continue;
					try {
						const renewed = await deps.prisma.librarySource.updateMany({
							where: fence(),
							data: {
								leaseUntil: new Date(now().getTime() + ANALYSIS_LEASE_MS),
							},
						});
						if (!renewed.count) break;
						const raw = redactSecrets(await read(locale));
						const document = normalizeSceneAnalysis(raw);
						const rawHash = createHash("sha256")
							.update(JSON.stringify(raw))
							.digest("hex");
						await deps.prisma.$transaction(async (tx) => {
							const owned = await tx.librarySource.updateMany({
								where: fence(),
								data: { error: null },
							});
							if (!owned.count) return;
							await tx.sceneAnalysisRevision.upsert({
								where: {
									sourceId_locale_rawHash: {
										sourceId: row.id,
										locale,
										rawHash,
									},
								},
								update: {},
								create: {
									sourceId: row.id,
									locale,
									rawHash,
									providerVersion: document.providerVersion,
									raw: raw as Prisma.InputJsonValue,
									document: JSON.parse(
										JSON.stringify(document),
									) as Prisma.InputJsonValue,
								},
							});
							completed.add(locale);
						});
					} catch {
						failed = true;
					}
				}
				failed ||=
					row.locales.length === 0 ||
					row.locales.some((locale) => !completed.has(locale));
			} catch {
				failed = true;
			}
			await deps.prisma.librarySource.updateMany({
				where: fence(),
				data: {
					state: failed ? "ERROR" : "READY",
					leaseToken: null,
					leaseUntil: null,
					availableAt: new Date(
						now().getTime() + Math.min(60 * 60_000, 30_000 * 2 ** row.attempts),
					),
					// Never persist SDK errors: they can include account headers or provider response bodies.
					error: failed
						? "Analysis import incomplete; retry scheduled until attempt limit"
						: null,
				},
			});
		}
	};
}

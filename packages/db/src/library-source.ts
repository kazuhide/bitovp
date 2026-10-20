import { createHash } from "node:crypto";
import {
	encodingPlanSchema,
	libraryFileOutputs,
	libraryPlaybackLinks,
	librarySnapshotSchema,
	redactSecrets,
	sceneAnalysisLocales,
} from "@bitovp/core";
import type { Prisma } from "../generated/client";
import type { AppPrismaClient } from "./client";

export class LibrarySourceError extends Error {
	constructor(
		public readonly status: 400 | 404 | 409,
		/** Authored customer guidance only. Never pass an SDK/DB error here. */
		public readonly publicMessage: string,
	) {
		super(publicMessage);
	}
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Capture and enqueue in one transaction; the row lock orders capture vs deletion. */
export async function requestLibrarySource(
	prisma: AppPrismaClient,
	jobId: string,
	options: { explicit?: boolean } = {},
) {
	return prisma.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id = ${jobId}::uuid FOR UPDATE`;
		const job = await tx.encodingJob.findUnique({
			where: { id: jobId },
			select: {
				id: true,
				name: true,
				status: true,
				libraryCaptureSuppressed: true,
				plan: true,
				bitmovinEncodingId: true,
				bitmovinAccountId: true,
				qcVerdict: true,
				qcOverriddenAt: true,
			},
		});
		if (!job) throw new LibrarySourceError(404, "Encoding job not found");
		if (job.libraryCaptureSuppressed && !options.explicit) {
			throw new LibrarySourceError(
				409,
				"Reset disabled automatic library capture for this job. Request capture explicitly to register it again.",
			);
		}
		if (job.status !== "FINISHED")
			throw new LibrarySourceError(409, "Only finished jobs can be captured");
		const parsed = encodingPlanSchema.safeParse(job.plan);
		if (!parsed.success) {
			throw new LibrarySourceError(409, "Job has no valid encoding plan");
		}
		if (
			!job.bitmovinEncodingId ||
			!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
				job.bitmovinEncodingId,
			) ||
			!job.bitmovinAccountId
		) {
			throw new LibrarySourceError(
				409,
				"Encoding or account identity is missing",
			);
		}
		const plan = parsed.data;
		const locales = plan.aiSceneAnalysis
			? sceneAnalysisLocales(plan.aiSceneAnalysis.outputLanguageCodes)
			: [];
		const description = plan.aiSceneAnalysis?.assetDescription;
		const output = plan.outputs.find(
			(item) => item.key === description?.destination.outputKey,
		);
		const analysisOutput =
			description && output && "credentialId" in output && "bucket" in output
				? {
						credentialId: output.credentialId,
						bucket: output.bucket,
						path: description.destination.path,
						filename: description.filename,
					}
				: undefined;
		if (
			locales.some(
				(locale) => !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale),
			)
		) {
			throw new LibrarySourceError(409, "Analysis language codes are invalid");
		}
		const planHash = hash(job.plan);
		const sourceKey = hash([job.id, job.bitmovinEncodingId, planHash]);
		// Order legacy snapshot upgrade against both ingestion leases and manual registration.
		await tx.$queryRaw`SELECT id FROM "LibrarySource" WHERE "sourceKey" = ${sourceKey} FOR UPDATE`;
		const existing = await tx.librarySource.findUnique({
			where: { sourceKey },
		});
		const playbackLinks = async () => {
			const credentials = await tx.credential.findMany({
				where: {
					id: {
						in: plan.outputs.flatMap((output) =>
							"credentialId" in output ? [output.credentialId] : [],
						),
					},
				},
				select: { id: true, provider: true, config: true },
			});
			return libraryPlaybackLinks(
				plan,
				credentials.map((credential) => ({
					...credential,
					config: credential.config as Record<string, unknown>,
				})),
			);
		};
		const register = async (source: NonNullable<typeof existing>) => {
			// Same lock as manual registration: one asset even with concurrent callers.
			await tx.$queryRaw`SELECT id FROM "LibrarySource" WHERE id = ${source.id}::uuid FOR UPDATE`;
			if (
				!(await tx.content.findUnique({
					where: { registrationKey: source.id },
				}))
			) {
				const metadata = {
					title: job.name.trim().slice(0, 500) || "Untitled",
					description: "",
					tags: [] as string[],
					locale: locales[0] ?? "und",
				};
				const content = await tx.content.create({
					data: { registrationKey: source.id, ...metadata },
				});
				await tx.contentRevision.create({
					data: {
						contentId: content.id,
						sourceId: source.id,
						revision: 1,
						...metadata,
						createdBy: null,
					},
				});
			}
			// A row lock alone does not advance a waiting Serializable reset's
			// snapshot. Always version the locked job after registration, including
			// automatic capture, so that reset aborts rather than missing this new
			// source. The suppression guard above still requires explicit recapture
			// to clear true; any failed registration rolls this transaction back.
			await tx.encodingJob.update({
				where: { id: jobId },
				data: { libraryCaptureSuppressed: false },
			});
			return source;
		};
		if (existing) {
			const snapshot = librarySnapshotSchema.parse(existing.snapshot);
			const fileOutputs =
				snapshot.planHash === planHash && !snapshot.fileOutputs
					? libraryFileOutputs(plan)
					: undefined;
			const missingMp4 =
				snapshot.planHash === planHash &&
				libraryPlaybackLinks(plan, []).some(
					(link) =>
						link.kind === "MP4" &&
						!snapshot.playbackLinks.some((stored) => stored.key === link.key),
				);
			const upgradeAnalysis = analysisOutput && !snapshot.analysisOutput;
			const upgradeLocales =
				snapshot.planHash === planHash &&
				locales.some((locale) => !existing.locales.includes(locale));
			// Fill missing capture metadata once, without rewriting editorial metadata.
			if (
				(upgradeAnalysis ||
					upgradeLocales ||
					missingMp4 ||
					fileOutputs?.length) &&
				existing.state !== "RUNNING"
			) {
				const additions = missingMp4
					? (await playbackLinks()).filter(
							(link) =>
								link.kind === "MP4" &&
								!snapshot.playbackLinks.some(
									(stored) => stored.key === link.key,
								),
						)
					: [];
				const upgraded = await tx.librarySource.update({
					where: { id: existing.id },
					data: {
						...(upgradeLocales
							? { locales: [...new Set([...existing.locales, ...locales])] }
							: {}),
						snapshot: {
							...(existing.snapshot as Prisma.InputJsonObject),
							playbackLinks: [...snapshot.playbackLinks, ...additions],
							...(fileOutputs ? { fileOutputs } : {}),
							...(upgradeAnalysis ? { analysisOutput } : {}),
						} as Prisma.InputJsonValue,
						...(upgradeLocales ||
						(upgradeAnalysis && existing.state === "ERROR")
							? {
									state: "PENDING",
									attempts: 0,
									availableAt: new Date(),
									error: null,
								}
							: {}),
					},
				});
				return register(upgraded);
			}
			return register(existing);
		}
		const qcEvidence = await tx.vmafJob.findMany({
			where: { encodingJobId: jobId },
			orderBy: { createdAt: "desc" },
			take: 20,
			select: {
				id: true,
				mode: true,
				model: true,
				scoringVersion: true,
				status: true,
				gateVerdict: true,
				createdAt: true,
				results: {
					take: 100,
					orderBy: { id: "asc" },
					select: {
						id: true,
						renditionRef: true,
						pooled: true,
						provenance: true,
					},
				},
			},
		});
		const snapshot = {
			schemaVersion: 1,
			kind: "VOD_JOB",
			name: job.name,
			planHash,
			identity: "UNVERIFIED",
			inputs: plan.ingest
				.filter((input) => "inputPath" in input)
				.map((input) => ({
					name:
						plan.inputs.find((item) => item.key === input.inputKey)?.name ??
						input.key,
					path: input.inputPath,
				})),
			playbackLinks: await playbackLinks(),
			fileOutputs: libraryFileOutputs(plan),
			qcVerdict: redactSecrets(job.qcVerdict),
			qcOverriddenAt: job.qcOverriddenAt?.toISOString() ?? null,
			qcEvidence: redactSecrets(qcEvidence),
			...(analysisOutput ? { analysisOutput } : {}),
		};
		const source = await tx.librarySource.create({
			data: {
				sourceKey,
				jobId,
				originalJobId: jobId,
				encodingId: job.bitmovinEncodingId,
				accountId: job.bitmovinAccountId,
				locales,
				state: locales.length ? "PENDING" : "READY",
				snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
			},
		});
		return register(source);
	});
}

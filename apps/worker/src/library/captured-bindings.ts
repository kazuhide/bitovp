import { createHash } from "node:crypto";
import {
	type AuthoritativeAnalysisCapture,
	authoritativeAnalysisCaptureSchema,
	cfrTimeMapSchema,
	editingAnalysisBindingSchema,
	hashEditingEvidence,
	normalizationCaptureReceiptSchema,
	normalizeSceneAnalysis,
	redactSecrets,
	sceneAnalysisLocales,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	type CapturedOriginalInput,
	listCapturedOriginalInputs,
	type Prisma,
} from "@bitovp/db";
import { buildNormalizationRecipe } from "../library-editing/normalization";

export type AuthoritativeProviderAnalysis = {
	accountId: string;
	encodingId: string;
	locale: string;
	providerResponseSha256: string;
	raw: unknown;
};
const json = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function captureFail(): never {
	throw new Error("ANALYSIS_CAPTURE_UNVERIFIED");
}
function bindingFail(): never {
	throw new Error("CAPTURED_BINDING_UNVERIFIED");
}
const transformHash = (input: CapturedOriginalInput) =>
	hashEditingEvidence({
		kind: "IDENTITY_SINGLE_INPUT_V1",
		inputReceiptId: input.receiptId,
		ingestKey: input.proof.ingestKey,
		sourceFactsHash: hashEditingEvidence(input.sourceFacts),
	});

/** Append-only: a conflict may preserve the exact receipt, never repair it. */
async function appendReceipt(
	tx: AppTransactionClient,
	data: {
		organizationId: string;
		sourceId: string;
		analysisRevisionId: string;
		jobId: string;
		encodingId: string;
		kind: "ANALYSIS_CAPTURE";
		proof: AuthoritativeAnalysisCapture;
	},
) {
	const proofHash = hashEditingEvidence(data.proof);
	const where = {
		organizationId: data.organizationId,
		kind: data.kind,
		proofHash,
	};
	const check = (
		row: {
			organizationId: string;
			sourceId: string | null;
			analysisRevisionId: string | null;
			jobId: string | null;
			encodingId: string | null;
			proofHash: string;
			proof: unknown;
		} | null,
	) => {
		if (
			!row ||
			row.organizationId !== data.organizationId ||
			row.sourceId !== data.sourceId ||
			row.analysisRevisionId !== data.analysisRevisionId ||
			row.jobId !== data.jobId ||
			row.encodingId !== data.encodingId ||
			row.proofHash !== proofHash ||
			hashEditingEvidence(row.proof) !== proofHash
		)
			captureFail();
	};
	const prior = await tx.libraryEvidenceReceipt.findFirst({ where });
	if (prior) {
		check(prior);
		return;
	}
	try {
		check(
			await tx.libraryEvidenceReceipt.create({
				data: { ...data, proof: json(data.proof), proofHash },
			}),
		);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "P2002"
			)
		)
			throw error;
		check(await tx.libraryEvidenceReceipt.findFirst({ where }));
	}
}

/** Called under the importer's source lease/row lock, in the revision INSERT transaction. */
export async function recordAuthoritativeAnalysisCapture(input: {
	tx: AppTransactionClient;
	organizationId: string;
	sourceId: string;
	response: AuthoritativeProviderAnalysis;
}): Promise<{ analysisRevisionId: string }> {
	const source = await input.tx.librarySource.findUnique({
		where: { id: input.sourceId },
	});
	const response = input.response;
	if (
		!source ||
		source.organizationId !== input.organizationId ||
		source.accountId !== response.accountId ||
		source.encodingId !== response.encodingId ||
		!sceneAnalysisLocales(source.locales).includes(response.locale) ||
		!/^[a-f0-9]{64}$/.test(response.providerResponseSha256)
	)
		captureFail();
	const inputs = await listCapturedOriginalInputs({
		prisma: input.tx,
		organizationId: input.organizationId,
		sourceId: input.sourceId,
	});
	if (inputs.length !== 1) captureFail();
	const captured = inputs[0];
	if (!captured) captureFail();
	const raw = redactSecrets(response.raw);
	const document = normalizeSceneAnalysis(raw);
	const rawHash = createHash("sha256")
		.update(JSON.stringify(raw))
		.digest("hex");
	const where = {
		sourceId_locale_rawHash: {
			sourceId: input.sourceId,
			locale: response.locale,
			rawHash,
		},
	};
	const prior = await input.tx.sceneAnalysisRevision.findUnique({ where });
	if (prior) {
		if (
			prior.organizationId !== input.organizationId ||
			prior.sourceId !== input.sourceId ||
			prior.locale !== response.locale ||
			prior.rawHash !== rawHash
		)
			captureFail();
		const rows = await input.tx.libraryEvidenceReceipt.findMany({
			where: {
				organizationId: input.organizationId,
				sourceId: input.sourceId,
				analysisRevisionId: prior.id,
				kind: "ANALYSIS_CAPTURE",
			},
			take: 101,
		});
		if (rows.length > 100) captureFail();
		const exact = rows.some((row) => {
			const proof = authoritativeAnalysisCaptureSchema.safeParse(row.proof);
			return (
				proof.success &&
				row.organizationId === input.organizationId &&
				row.sourceId === input.sourceId &&
				row.analysisRevisionId === prior.id &&
				row.jobId === captured.proof.jobId &&
				row.encodingId === captured.proof.encodingId &&
				row.proofHash === hashEditingEvidence(row.proof) &&
				proof.data.inputReceiptId === captured.receiptId &&
				proof.data.ingestionRawHash === rawHash &&
				proof.data.storedRawHash === hashEditingEvidence(prior.raw) &&
				proof.data.storedDocumentHash === hashEditingEvidence(prior.document) &&
				proof.data.organizationId === input.organizationId &&
				proof.data.sourceId === input.sourceId &&
				proof.data.analysisRevisionId === prior.id &&
				proof.data.accountId === response.accountId &&
				proof.data.encodingId === response.encodingId &&
				proof.data.locale === response.locale &&
				proof.data.planHash === captured.proof.planHash &&
				proof.data.inputTransformHash === transformHash(captured) &&
				proof.data.providerInputId === captured.providerInputId &&
				proof.data.ingestStreamId === captured.ingestStreamId
			);
		});
		// Existing storage imports are eligible only when both complete values match
		// the authoritative GET. No rawHash-only adoption or numeric tolerance.
		if (exact) return { analysisRevisionId: prior.id };
		if (
			hashEditingEvidence(prior.raw) !== hashEditingEvidence(raw) ||
			hashEditingEvidence(prior.document) !== hashEditingEvidence(document)
		)
			captureFail();
	}
	const analysis =
		prior ??
		(await input.tx.sceneAnalysisRevision.upsert({
			where,
			update: {},
			create: {
				organizationId: input.organizationId,
				sourceId: input.sourceId,
				locale: response.locale,
				rawHash,
				providerVersion: document.providerVersion,
				raw: json(raw),
				document: json(document),
			},
		}));
	if (
		analysis.organizationId !== input.organizationId ||
		analysis.sourceId !== input.sourceId ||
		analysis.locale !== response.locale ||
		analysis.rawHash !== rawHash
	)
		captureFail();
	// Hash the values returned by this atomic insertion, including JSONB's stored
	// numeric representation. The input/rawHash relation was established above.
	const proof = authoritativeAnalysisCaptureSchema.parse({
		schemaVersion: 1,
		profile: "BITMOVIN_ANALYSIS_HTTP_V1",
		organizationId: input.organizationId,
		sourceId: input.sourceId,
		jobId: captured.proof.jobId,
		encodingId: response.encodingId,
		accountId: response.accountId,
		analysisRevisionId: analysis.id,
		locale: response.locale,
		inputReceiptId: captured.receiptId,
		providerInputId: captured.providerInputId,
		ingestStreamId: captured.ingestStreamId,
		providerResponseSha256: response.providerResponseSha256,
		ingestionRawHash: rawHash,
		storedRawHash: hashEditingEvidence(analysis.raw),
		storedDocumentHash: hashEditingEvidence(analysis.document),
		planHash: captured.proof.planHash,
		inputTransformHash: transformHash(captured),
	});
	await appendReceipt(input.tx, {
		organizationId: input.organizationId,
		sourceId: input.sourceId,
		analysisRevisionId: analysis.id,
		jobId: proof.jobId,
		encodingId: proof.encodingId,
		kind: "ANALYSIS_CAPTURE",
		proof,
	});
	return { analysisRevisionId: analysis.id };
}

/** Either completion order and replay converge without rewriting any evidence. */
export async function reconcileCapturedBindings(input: {
	prisma: AppPrismaClient;
	organizationId: string;
	sourceId: string;
}): Promise<{ created: number; preserved: number }> {
	return input.prisma
		.$transaction(async (tx) => {
			const locked = await tx.$queryRaw<
				{ id: string }[]
			>`SELECT "id" FROM "LibrarySource" WHERE "id" = ${input.sourceId}::uuid AND "organizationId" = ${input.organizationId}::uuid FOR UPDATE`;
			if (locked.length !== 1) return { created: 0, preserved: 0 };
			const captured = await listCapturedOriginalInputs({
				prisma: tx,
				organizationId: input.organizationId,
				sourceId: input.sourceId,
			});
			if (!captured.length) return { created: 0, preserved: 0 };
			if (captured.length !== 1) bindingFail();
			const original = captured[0];
			if (!original) bindingFail();
			// Keep the exact receipts alive until the immutable sealed binding is written.
			await tx.$queryRaw`SELECT "id" FROM "LibraryEvidenceReceipt" WHERE "organizationId" = ${input.organizationId}::uuid AND ("sourceId" = ${input.sourceId}::uuid OR "id" = ${original.receiptId}::uuid) FOR KEY SHARE`;
			const retained = await listCapturedOriginalInputs({
				prisma: tx,
				organizationId: input.organizationId,
				sourceId: input.sourceId,
			});
			if (
				retained.length !== 1 ||
				retained[0]?.receiptId !== original.receiptId ||
				hashEditingEvidence(retained[0]?.proof) !==
					hashEditingEvidence(original.proof)
			)
				bindingFail();
			const receipts = await tx.libraryEvidenceReceipt.findMany({
				where: {
					organizationId: input.organizationId,
					sourceId: input.sourceId,
					kind: { in: ["ANALYSIS_CAPTURE", "NORMALIZATION_CAPTURE"] },
				},
				take: 201,
			});
			const mediaRows = await tx.libraryMediaVersion.findMany({
				where: {
					organizationId: input.organizationId,
					sourceId: input.sourceId,
					state: "READY",
				},
				take: 101,
			});
			const analyses = await tx.sceneAnalysisRevision.findMany({
				where: {
					organizationId: input.organizationId,
					sourceId: input.sourceId,
				},
				take: 101,
			});
			if (
				receipts.length > 200 ||
				mediaRows.length > 100 ||
				analyses.length > 100
			)
				bindingFail();
			let created = 0,
				preserved = 0;
			for (const media of mediaRows) {
				const storage =
					media.storage &&
					typeof media.storage === "object" &&
					!Array.isArray(media.storage)
						? (media.storage as Record<string, unknown>)
						: {};
				// HLS materialization is a new source, even if its locator resembles the original.
				if (storage.sourceFormat === "HLS") continue;
				// Encoded output variants do not inherit the original-input proof.
				if (
					hashEditingEvidence(storage.source ?? null) !==
					hashEditingEvidence(original.storage)
				)
					continue;
				const norms = receipts.filter(
					(row) =>
						row.kind === "NORMALIZATION_CAPTURE" &&
						row.mediaVersionId === media.id,
				);
				if (!norms.length) continue;
				if (norms.length !== 1) bindingFail();
				const row = norms[0];
				if (!row) bindingFail();
				const norm = normalizationCaptureReceiptSchema.parse(row.proof);
				const map = cfrTimeMapSchema.parse(media.timeMap);
				const recipe = buildNormalizationRecipe(norm.source);
				if (
					row.proofHash !== hashEditingEvidence(row.proof) ||
					norm.organizationId !== input.organizationId ||
					norm.sourceId !== input.sourceId ||
					norm.mediaVersionId !== media.id ||
					norm.timeMapId !== map.id ||
					norm.originalSha256 !== original.proof.sha256 ||
					norm.originalBytes !== original.storage.size ||
					hashEditingEvidence(norm.source) !==
						hashEditingEvidence(original.sourceFacts) ||
					norm.preparedSha256 !== media.sha256 ||
					norm.output.width !== media.width ||
					norm.output.height !== media.height ||
					BigInt(norm.output.durationUs) !== media.durationUs ||
					media.fpsNum !== 30 ||
					media.fpsDen !== 1 ||
					map.mediaVersionId !== media.id ||
					map.sourceStartUs !== 0 ||
					map.sourceEndUs !== norm.sourceEndUs ||
					map.editingStartFrame !== 0 ||
					map.editingEndFrame !== norm.output.frameCount ||
					norm.indexMapHash !== hashEditingEvidence(norm.sourceFrameIndex) ||
					norm.recipeHash !==
						hashEditingEvidence({
							profile: norm.profile,
							mode: norm.mode,
							source: norm.source,
							videoFilter: recipe.videoFilter,
							audioFilter: recipe.audioFilter,
						})
				)
					bindingFail();
				for (const analysis of analyses) {
					const captures = receipts.filter(
						(entry) =>
							entry.kind === "ANALYSIS_CAPTURE" &&
							entry.analysisRevisionId === analysis.id,
					);
					if (!captures.length) continue;
					for (const entry of captures) {
						const proof = authoritativeAnalysisCaptureSchema.parse(entry.proof);
						const source = await tx.librarySource.findUnique({
							where: { id: input.sourceId },
						});
						if (
							entry.proofHash !== hashEditingEvidence(entry.proof) ||
							proof.organizationId !== input.organizationId ||
							proof.sourceId !== input.sourceId ||
							proof.analysisRevisionId !== analysis.id ||
							analysis.organizationId !== input.organizationId ||
							analysis.sourceId !== input.sourceId ||
							proof.locale !== analysis.locale ||
							proof.ingestionRawHash !== analysis.rawHash ||
							proof.storedRawHash !== hashEditingEvidence(analysis.raw) ||
							proof.storedDocumentHash !==
								hashEditingEvidence(analysis.document) ||
							proof.inputReceiptId !== original.receiptId ||
							proof.jobId !== original.proof.jobId ||
							proof.encodingId !== original.proof.encodingId ||
							proof.accountId !== source?.accountId ||
							proof.planHash !== original.proof.planHash ||
							proof.inputTransformHash !== transformHash(original) ||
							proof.providerInputId !== original.providerInputId ||
							proof.ingestStreamId !== original.ingestStreamId ||
							entry.jobId !== proof.jobId ||
							entry.encodingId !== proof.encodingId
						)
							bindingFail();
					}
					const binding = editingAnalysisBindingSchema.parse({
						schemaVersion: 1,
						kind: "CAPTURED_INPUT",
						organizationId: input.organizationId,
						sourceId: input.sourceId,
						locale: analysis.locale,
						analysisRevisionId: analysis.id,
						analysisRawHash: analysis.rawHash,
						analysisDocumentHash: hashEditingEvidence(analysis.document),
						mediaVersionId: media.id,
						mediaSha256: media.sha256,
						timeMapId: map.id,
						timeMapHash: hashEditingEvidence(media.timeMap),
						sourceStartUs: map.sourceStartUs,
						sourceEndUs: map.sourceEndUs,
						width: media.width,
						height: media.height,
					});
					const where = {
						organizationId: input.organizationId,
						mediaVersionId: media.id,
						analysisRevisionId: analysis.id,
					};
					const assertPrior = (prior: { proof: unknown } | null) => {
						try {
							if (!prior) bindingFail();
							verifyAutomaticAnalysisBinding({
								organizationId: input.organizationId,
								media,
								analysis,
								bindings: [prior.proof],
							});
						} catch {
							bindingFail();
						}
					};
					const prior = await tx.libraryAnalysisBinding.findFirst({ where });
					if (prior) {
						assertPrior(prior);
						preserved++;
						continue;
					}
					try {
						await tx.libraryAnalysisBinding.create({
							data: { ...where, proof: json(binding) },
						});
						created++;
					} catch (error) {
						if (
							!(
								error &&
								typeof error === "object" &&
								"code" in error &&
								error.code === "P2002"
							)
						)
							throw error;
						assertPrior(await tx.libraryAnalysisBinding.findFirst({ where }));
						preserved++;
					}
				}
			}
			return { created, preserved };
		})
		.catch((error: unknown) => {
			if (
				error instanceof Error &&
				error.message === "CAPTURED_BINDING_UNVERIFIED"
			)
				throw error;
			bindingFail();
		});
}

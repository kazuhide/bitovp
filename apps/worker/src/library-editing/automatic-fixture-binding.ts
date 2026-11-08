import { createHash } from "node:crypto";
import {
	canonicalEditingJson,
	cfrTimeMapSchema,
	type EditingAnalysisBinding,
	editingAnalysisBindingSchema,
	hashEditingEvidence,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import {
	ANIMATION_REGISTRATION_KEY,
	ANIMATION_SOURCE_ID,
	animationAnalysis,
	animationDemo,
} from "./animation-fixture";
import {
	PREVIEW_REGISTRATION_KEY,
	PREVIEW_SOURCE_ID,
	previewAnalysis,
} from "./preview-fixture";

const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Internal, local-preview authoring only. This never asserts provider provenance. */
export async function sealAutomaticFixtureBindings(input: {
	prisma: AppPrismaClient;
	organizationId: string;
	fixture: "ANIMATION" | "SYNTHETIC";
	/** Digest of the actual normalized fixture object, not the original film. */
	sourceSha256: string;
}): Promise<{ attached: number; preserved: number }> {
	const { prisma, organizationId } = input;
	const animation = input.fixture === "ANIMATION";
	const sourceId = animation ? ANIMATION_SOURCE_ID : PREVIEW_SOURCE_ID;
	const sourceKey = animation
		? ANIMATION_REGISTRATION_KEY
		: PREVIEW_REGISTRATION_KEY;
	const expectedRaw = animation ? animationAnalysis() : previewAnalysis();
	const document = normalizeSceneAnalysis(expectedRaw);
	// Existing revisions use the ingestion hash, not a canonical raw-object hash.
	const rawHash = createHash("sha256")
		.update(JSON.stringify(expectedRaw))
		.digest("hex");
	const source = await prisma.librarySource.findUnique({
		where: { id: sourceId },
	});
	if (
		!source ||
		source.organizationId !== organizationId ||
		source.sourceKey !== sourceKey ||
		!/^[a-f0-9]{64}$/.test(input.sourceSha256)
	)
		throw new Error("PREVIEW_SOURCE_WAS_CHANGED");
	const analyses = await prisma.sceneAnalysisRevision.findMany({
		where: { organizationId, sourceId, locale: "ja" },
		take: 101,
	});
	const matching = analyses.filter((row) => row.rawHash === rawHash);
	if (analyses.length > 100 || matching.length !== 1)
		throw new Error("PREVIEW_ANALYSIS_WAS_CHANGED");
	const analysis = matching[0];
	if (!analysis) throw new Error("PREVIEW_ANALYSIS_WAS_CHANGED");
	const storedRawHash = hashEditingEvidence(analysis.raw);
	const storedDocumentHash = hashEditingEvidence(analysis.document);
	const expectedDocumentHash = hashEditingEvidence(document);
	// Captured from the v1 local demo: its original Prisma JSON write changed
	// 18.966666666666665 to 18.96666666666667 in both raw and normalized JSON.
	// Accept only that complete, paired representation of the unchanged fixture.
	// Runtime proof continues to hash the stored JSON; no numeric tolerance or
	// legacy-provider compatibility is introduced at the verification boundary.
	const capturedAnimationStorage =
		animation &&
		rawHash ===
			"c8b11d0f0a370a0e4bbec4c5e4208893b545c2926a4982958eadf2b576a8e7f1" &&
		expectedDocumentHash ===
			"d46d38ef71b67df64230f8daafa9329cd939807540531d20e97255b817f68185" &&
		storedRawHash ===
			"f51e73e39238b8a79869e15b971971d5fc12d0037d9620688149534373df1f60" &&
		storedDocumentHash ===
			"d0064d5e9be69322b4aeb4335a79226cb16e20fc7dad0fd0da771c506e072472";
	if (
		analysis.organizationId !== organizationId ||
		analysis.sourceId !== sourceId ||
		analysis.locale !== "ja" ||
		(!capturedAnimationStorage &&
			(storedRawHash !== hashEditingEvidence(expectedRaw) ||
				storedDocumentHash !== expectedDocumentHash))
	)
		throw new Error("PREVIEW_ANALYSIS_WAS_CHANGED");
	const rows = await prisma.libraryMediaVersion.findMany({
		where: { organizationId, sourceId, state: "READY" },
		take: 101,
	});
	if (rows.length > 100) throw new Error("PREVIEW_MEDIA_LIMIT");
	const width = animation ? animationDemo.profile.width : 960;
	const height = animation ? animationDemo.profile.height : 540;
	const frames = animation ? animationDemo.profile.frameCount : 540;
	const durationUs = animation ? 30_000_000 : 18_000_000;
	let attached = 0;
	let preserved = 0;
	for (const media of rows) {
		const parsedMap = cfrTimeMapSchema.safeParse(media.timeMap);
		if (
			media.organizationId !== organizationId ||
			media.sourceId !== sourceId ||
			media.state !== "READY" ||
			media.sha256 !== input.sourceSha256 ||
			media.width !== width ||
			media.height !== height ||
			media.durationUs !== BigInt(durationUs) ||
			media.fpsNum !== 30 ||
			media.fpsDen !== 1 ||
			!parsedMap.success ||
			parsedMap.data.id !== media.id ||
			parsedMap.data.mediaVersionId !== media.id ||
			parsedMap.data.sourceStartUs !== 0 ||
			parsedMap.data.sourceEndUs !== durationUs ||
			parsedMap.data.editingStartFrame !== 0 ||
			parsedMap.data.editingEndFrame !== frames
		)
			throw new Error("PREVIEW_MEDIA_WAS_CHANGED");
		const binding = editingAnalysisBindingSchema.parse({
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId,
			sourceId,
			locale: analysis.locale,
			analysisRevisionId: analysis.id,
			analysisRawHash: analysis.rawHash,
			analysisDocumentHash: hashEditingEvidence(analysis.document),
			mediaVersionId: media.id,
			mediaSha256: media.sha256,
			timeMapId: parsedMap.data.id,
			timeMapHash: hashEditingEvidence(media.timeMap),
			sourceStartUs: 0,
			sourceEndUs: durationUs,
			width,
			height,
		});
		const where = {
			organizationId,
			mediaVersionId: media.id,
			analysisRevisionId: analysis.id,
		};
		const assertUnchanged = (
			prior: {
				organizationId: string;
				mediaVersionId: string;
				analysisRevisionId: string;
				proof: unknown;
			} | null,
			expected: EditingAnalysisBinding,
		) => {
			const proof = editingAnalysisBindingSchema.safeParse(prior?.proof);
			if (
				!prior ||
				prior.organizationId !== organizationId ||
				prior.mediaVersionId !== media.id ||
				prior.analysisRevisionId !== analysis.id ||
				!proof.success ||
				canonicalEditingJson(proof.data) !== canonicalEditingJson(expected)
			)
				throw new Error("PREVIEW_BINDING_WAS_CHANGED");
		};
		const prior = await prisma.libraryAnalysisBinding.findFirst({ where });
		if (prior) {
			assertUnchanged(prior, binding);
			preserved += 1;
			continue;
		}
		try {
			await prisma.libraryAnalysisBinding.create({
				data: { ...where, proof: json(binding) },
			});
			attached += 1;
		} catch (error) {
			if (
				!error ||
				typeof error !== "object" ||
				!("code" in error) ||
				error.code !== "P2002"
			)
				throw error;
			assertUnchanged(
				await prisma.libraryAnalysisBinding.findFirst({ where }),
				binding,
			);
			preserved += 1;
		}
	}
	return { attached, preserved };
}

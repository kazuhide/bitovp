import { createHash } from "node:crypto";
import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	canonicalEditingJson,
	type EditingAnalysisBinding,
	editingAnalysisBindingSchema,
} from "./automatic-binding";
import { cfrTimeMapSchema } from "./schema";

export class AutomaticBindingError extends Error {
	readonly code = "ANALYSIS_BINDING_UNVERIFIED";
	constructor() {
		super("ANALYSIS_BINDING_UNVERIFIED");
		this.name = "AutomaticBindingError";
	}
}

/** Stable JSON evidence hashing, independent of JSONB object-key order. */
export function hashEditingEvidence(value: unknown): string {
	return createHash("sha256").update(canonicalEditingJson(value)).digest("hex");
}

type AutomaticBindingInput = {
	organizationId: string;
	media: {
		organizationId: string;
		id: string;
		sourceId: string;
		sha256: string | null;
		width: number | null;
		height: number | null;
		timeMap: unknown;
	};
	analysis: {
		organizationId: string;
		id: string;
		sourceId: string;
		locale: string;
		rawHash: string;
		document: unknown;
	};
	/** Proofs read from the server-owned immutable binding table. Never from probe. */
	bindings?: unknown;
	/** A saved revision must retain exactly one of the server's sealed proofs. */
	binding?: unknown;
};

/** Server-owned evidence is mandatory; source IDs and durations are not proof. */
export function verifyAutomaticAnalysisBinding(
	input: AutomaticBindingInput,
): EditingAnalysisBinding {
	try {
		const { media, analysis, organizationId } = input;
		if (
			media.organizationId !== organizationId ||
			analysis.organizationId !== organizationId ||
			media.sourceId !== analysis.sourceId
		)
			throw new AutomaticBindingError();
		const map = cfrTimeMapSchema.parse(media.timeMap);
		if (map.mediaVersionId !== media.id) throw new AutomaticBindingError();
		sceneAnalysisDocumentSchema.parse(analysis.document);
		const proofs = editingAnalysisBindingSchema
			.array()
			.min(1)
			.max(25)
			.parse(input.bindings);
		const expectedFacts = {
			organizationId,
			sourceId: media.sourceId,
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
		};
		const requested =
			input.binding === undefined
				? undefined
				: canonicalEditingJson(
						editingAnalysisBindingSchema.parse(input.binding),
					);
		const matching = proofs.filter((proof) =>
			Object.entries(expectedFacts).every(
				([key, value]) => proof[key as keyof EditingAnalysisBinding] === value,
			),
		);
		const exact = new Map(
			matching
				.filter(
					(proof) => !requested || canonicalEditingJson(proof) === requested,
				)
				.map((proof) => [canonicalEditingJson(proof), proof]),
		);
		if (exact.size !== 1) throw new AutomaticBindingError();
		return [...exact.values()][0] as EditingAnalysisBinding;
	} catch {
		// Do not disclose provider payloads, private object paths, or validation values.
		throw new AutomaticBindingError();
	}
}

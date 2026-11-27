import { type StepLogEntry, stepLogSchema } from "@bitovp/core";
import { diagnosticChoices } from "./diagnostics";
import { isResourceId, type ParentRef, type ResourceAddress } from "./family";
import { resourceFamilyForStep } from "./registry";
import { childChoices } from "./resource-children";

const producers: Record<ParentRef, readonly string[]> = {
	encodingId: ["CREATE_ENCODING", "RESOLVE_AISA_LIVE_ENCODING"],
	streamId: ["CREATE_STREAM"],
	muxingId: [
		"CREATE_MUXING_FMP4",
		"CREATE_MUXING_MP4",
		"CREATE_MUXING_TS",
		"CREATE_MUXING_WEBM",
		"CREATE_MUXING_PROGRESSIVE_TS",
		"CREATE_MUXING_PROGRESSIVE_WEBM",
	],
	manifestId: [
		"CREATE_MANIFEST_DASH",
		"CREATE_MANIFEST_HLS",
		"CREATE_MANIFEST_SMOOTH",
	],
	periodId: ["CREATE_DASH_PERIOD"],
	adaptationSetId: [
		"CREATE_DASH_ADAPTATION_SET_AUDIO",
		"CREATE_DASH_ADAPTATION_SET_IMAGE",
		"CREATE_DASH_ADAPTATION_SET_SUBTITLE",
		"CREATE_DASH_ADAPTATION_SET_VIDEO",
	],
	streamInfoId: ["CREATE_HLS_STREAM_INFO"],
	drmId: ["CREATE_DRM_CENC", "CREATE_DRM_FAIRPLAY", "CREATE_DRM_SPEKE"],
	representationId: [
		"CREATE_DASH_REPRESENTATION_FMP4",
		"CREATE_DASH_REPRESENTATION_MP4",
		"CREATE_DASH_REPRESENTATION_WEBM",
	],
};
// A manifest and its input encoding have independent roots. Validate only actual graph edges.
const ancestors: Record<ParentRef, readonly ParentRef[]> = {
	manifestId: [],
	encodingId: [],
	periodId: ["manifestId"],
	adaptationSetId: ["manifestId", "periodId"],
	streamInfoId: ["manifestId"],
	streamId: ["encodingId"],
	muxingId: ["encodingId"],
	drmId: ["encodingId", "muxingId"],
	representationId: [
		"manifestId",
		"periodId",
		"adaptationSetId",
		"encodingId",
		"muxingId",
	],
};
function expectedMuxing(entry: StepLogEntry) {
	if (entry.kind.startsWith("CREATE_DRM_")) return entry.payload.muxingKind;
	if (
		entry.kind === "CREATE_DASH_REPRESENTATION_MP4" ||
		entry.kind === "CREATE_SMOOTH_CONTENT_PROTECTION"
	)
		return "MP4";
	if (entry.kind === "CREATE_DASH_REPRESENTATION_FMP4") return "FMP4";
	if (entry.kind === "CREATE_DASH_CONTENT_PROTECTION") {
		const kind = entry.payload.representationKind ?? "FMP4";
		return kind === "FMP4_DRM"
			? "FMP4"
			: kind === "ADAPTATION_SET"
				? undefined
				: kind;
	}
	return undefined;
}
export function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function parseResourceLog(value: unknown) {
	const parsed = stepLogSchema.safeParse(value);
	if (!parsed.success) return null;
	const steps = new Map<string, StepLogEntry>(),
		ids = new Map<string, StepLogEntry[]>();
	for (const entry of parsed.data) {
		if (steps.has(entry.step)) return null;
		steps.set(entry.step, entry);
		if (entry.status === "DONE" && entry.resourceId) {
			const sources = ids.get(entry.resourceId) ?? [];
			sources.push(entry);
			ids.set(entry.resourceId, sources);
		}
	}
	return { steps, ids };
}

export function selectResource(
	log: NonNullable<ReturnType<typeof parseResourceLog>>,
	step: string,
	live = false,
) {
	const entry = log.steps.get(step);
	if (entry?.status !== "DONE" || !isResourceId(entry.resourceId)) return;
	const family = resourceFamilyForStep(entry);
	if (!family) return;
	const parents = new Map<ParentRef, string>();
	const parentKinds = new Map<ParentRef, string>();
	const parentScopes: Array<StepLogEntry["resourceAccount"]> = [];
	const snapshot = object(object(entry.request)?.refs);
	for (const ref of family.parents) {
		const label = entry.refs[ref];
		if (typeof label !== "string") return;
		const candidates = log.steps.has(label)
			? [log.steps.get(label)]
			: log.ids.get(label);
		if (candidates?.length !== 1) return;
		const parent = candidates[0];
		if (
			parent?.status !== "DONE" ||
			!isResourceId(parent.resourceId) ||
			!producers[ref].includes(parent.kind)
		)
			return;
		if (ref === "muxingId") {
			const kind = expectedMuxing(entry);
			if (kind && parent.kind !== `CREATE_MUXING_${kind}`) return;
		}
		if (
			ref === "drmId" &&
			parentKinds.get("muxingId") !==
				`CREATE_MUXING_${parent.payload.muxingKind}`
		)
			return;
		if (ref === "representationId") {
			const kind = entry.payload.representationKind ?? "FMP4";
			const protectedRep = kind === "FMP4_DRM";
			if (
				parent.kind !==
					`CREATE_DASH_REPRESENTATION_${protectedRep ? "FMP4" : kind}` ||
				protectedRep !== !!parent.refs.drmId
			)
				return;
		}
		if (ref === "manifestId") {
			const expected = entry.kind.startsWith("CREATE_HLS_")
				? "CREATE_MANIFEST_HLS"
				: entry.kind.startsWith("CREATE_SMOOTH_")
					? "CREATE_MANIFEST_SMOOTH"
					: "CREATE_MANIFEST_DASH";
			if (parent.kind !== expected) return;
		}
		if (snapshot && snapshot[ref] !== parent.resourceId) return;
		const related: readonly ParentRef[] =
			ref === "representationId" &&
			entry.payload.representationKind === "FMP4_DRM"
				? [...ancestors[ref], "drmId"]
				: ancestors[ref];
		for (const ancestor of related) {
			const id = parents.get(ancestor);
			if (!id) continue;
			const parentRef = parent.refs[ancestor];
			if (typeof parentRef !== "string") return;
			const ancestorEntry = log.steps.get(parentRef);
			if ((ancestorEntry?.resourceId ?? parentRef) !== id) return;
			const requested = object(object(parent.request)?.refs)?.[ancestor];
			if (requested !== undefined && requested !== id) return;
		}
		parentScopes.push(parent.resourceAccount);
		parents.set(ref, parent.resourceId);
		parentKinds.set(ref, parent.kind);
	}
	const address: ResourceAddress = {
		id: entry.resourceId,
		parent(ref) {
			const id = parents.get(ref);
			if (!id) throw new Error("Missing resource parent");
			return id;
		},
	};
	return {
		entry,
		parentScopes,
		family,
		address,
		summary: {
			step: entry.step,
			kind: entry.kind,
			id: entry.resourceId,
			attempt: entry.attempt ?? 0,
			hasList: !!family.list,
			listScope: family.listScope,
			hasCustomData: !!family.customData,
			...(family.information && { hasInformation: true }),
			...(!family.remove && { readOnly: true }),
			childCollections: childChoices(entry.kind, live),
			diagnostics: diagnosticChoices(entry.kind),
		},
	};
}

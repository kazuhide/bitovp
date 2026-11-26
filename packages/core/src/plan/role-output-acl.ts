import type { CompiledOperation } from "./compiler";
import type { PlanOutput } from "./schema";

type OutputKind = PlanOutput["kind"];

export function vodOutputKinds(outputs: readonly PlanOutput[]) {
	return new Map(outputs.map(({ key, kind }) => [`output:${key}`, kind]));
}

const noAcl = new Set<OutputKind>([
	"AZURE",
	"SFTP",
	"AKAMAI_NETSTORAGE",
	"AKAMAI_MSL",
	"LIVE_MEDIA_INGEST",
	"MOQ",
]);

const roleAcl = (value: unknown) =>
	value === "PUBLIC_READ" ? "PUBLIC_READ" : "PRIVATE";

/** Apply to new compiler output and existing journal steps before execution. */
export function applyRoleOutputAcl(
	op: CompiledOperation,
	kinds: ReadonlyMap<string, OutputKind>,
): CompiledOperation {
	const kindOf = (ref: string | string[] | undefined) =>
		typeof ref === "string" ? kinds.get(ref) : undefined;
	const primary = kindOf(op.refs.outputId);
	const mirrorRefs = Array.isArray(op.refs.mirrorOutputIds)
		? op.refs.mirrorOutputIds
		: [];
	const hasRoleMirror = mirrorRefs.some(
		(ref) => kindOf(ref) === "S3_ROLE_BASED",
	);
	const hasRoleReport = kindOf(op.refs.reportOutputId) === "S3_ROLE_BASED";
	const hasRoleAisa =
		kindOf(op.refs.aiAssetDescriptionOutputId) === "S3_ROLE_BASED";
	if (
		primary !== "S3_ROLE_BASED" &&
		!hasRoleMirror &&
		!hasRoleReport &&
		!hasRoleAisa
	)
		return op;

	const payload = { ...op.payload };
	if (hasRoleMirror || primary === "S3_ROLE_BASED") {
		const previousMirrorAcls = Array.isArray(payload.mirrorOutputAcls)
			? payload.mirrorOutputAcls
			: undefined;
		if (mirrorRefs.length) {
			payload.mirrorOutputAcls = mirrorRefs.map((ref, index) => {
				const kind = kindOf(ref);
				if (kind === "S3_ROLE_BASED") return "PRIVATE";
				if (kind && noAcl.has(kind)) return null;
				const inherited = previousMirrorAcls
					? previousMirrorAcls[index]
					: payload.acl;
				return typeof inherited === "string" ? inherited : null;
			});
		}
		if (primary === "S3_ROLE_BASED") payload.acl = roleAcl(payload.acl);
		else if (primary && noAcl.has(primary)) delete payload.acl;
	}
	if (hasRoleReport) payload.reportAcl = roleAcl(payload.reportAcl);
	if (hasRoleAisa) {
		const ai = payload.aiSceneAnalysis as
			| { features?: { assetDescription?: { acl?: unknown } } }
			| undefined;
		const asset = ai?.features?.assetDescription;
		if (asset)
			payload.aiSceneAnalysis = {
				...ai,
				features: {
					...ai?.features,
					assetDescription: { ...asset, acl: roleAcl(asset.acl) },
				},
			};
	}
	return { ...op, payload };
}

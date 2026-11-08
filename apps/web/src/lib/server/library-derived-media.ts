import "server-only";
import {
	type EditingObject,
	editingObjectSchema,
	editingRenderProfileSchema,
	type LibrarySourceView,
} from "@bitovp/core";
import { requestOrganizationId } from "@/lib/passive-request";
import type { ServerContext } from "./context";
import { EditingRequestError } from "./library-editing-common";

type DerivedSource = {
	organizationId: string;
	sourceKind: string;
	renderArtifactId: string | null;
};
type FixedObject = EditingObject & {
	size: number;
	expect: NonNullable<EditingObject["expect"]>;
};
const unverified = (): never => {
	throw new EditingRequestError(409, "MEDIA_VERSION_UNVERIFIED");
};

/** A derivative reuses its immutable artifact locator; it never discovers a new version. */
export async function fixedDerivedLibraryObject(
	ctx: ServerContext,
	source: DerivedSource,
	snapshot: LibrarySourceView["snapshot"],
	fileKey: string,
): Promise<FixedObject> {
	if (
		source.sourceKind !== "DERIVED_RENDER" ||
		snapshot.kind !== "DERIVED_RENDER" ||
		source.organizationId !== requestOrganizationId(ctx) ||
		!source.renderArtifactId ||
		source.renderArtifactId !== snapshot.renderArtifactId ||
		fileKey !== `render-${source.renderArtifactId}`
	)
		return unverified();
	const files = snapshot.fileOutputs?.filter((file) => file.key === fileKey);
	if (files?.length !== 1 || files[0]?.kind !== "MP4") return unverified();
	const file = files[0];
	const artifact = await ctx.prisma.renderArtifact.findFirst({
		where: {
			id: source.renderArtifactId,
			organizationId: source.organizationId,
		},
		select: {
			id: true,
			organizationId: true,
			runId: true,
			size: true,
			storage: true,
			run: { select: { id: true, state: true, profile: true } },
		},
	});
	if (
		!artifact ||
		artifact.id !== source.renderArtifactId ||
		artifact.organizationId !== source.organizationId ||
		artifact.runId !== snapshot.renderRunId ||
		artifact.run.id !== snapshot.renderRunId ||
		artifact.run.state !== "SUCCEEDED"
	)
		return unverified();
	const profile = editingRenderProfileSchema.safeParse(artifact.run.profile);
	const parsed = editingObjectSchema.safeParse(artifact.storage);
	if (!profile.success || profile.data.kind !== "EXPORT" || !parsed.success)
		return unverified();
	const target = parsed.data;
	if (
		!target.size ||
		BigInt(target.size) !== artifact.size ||
		!target.expect ||
		!(
			target.expect.etag?.trim() ||
			(target.expect.versionId?.trim() && target.expect.versionId !== "null") ||
			target.expect.generation?.trim()
		) ||
		target.credentialId !== file.credentialId ||
		target.bucket !== file.bucket ||
		target.key !== file.path
	)
		return unverified();
	return { ...target, size: target.size, expect: target.expect };
}

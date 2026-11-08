import "server-only";
import { posix } from "node:path";
import {
	editingMediaStorageSchema,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	LibraryMediaVersion,
	SceneAnalysisRevision,
} from "@bitovp/db";
import type { ObjectIdentity } from "@bitovp/storage";
import type { AutomaticEditingContext } from "@/lib/library-editing";

export type AutomaticEditingOutput = {
	key: string;
	kind: "MP4" | "HLS";
	credentialId: string;
	bucket: string;
	path: string;
};
type Analysis = Pick<
	SceneAnalysisRevision,
	"id" | "organizationId" | "sourceId" | "locale" | "rawHash" | "document"
>;
type Source = {
	id: string;
	organizationId: string;
	sourceKind: string;
	encodingId: string | null;
};

/** Resolve the current encoding's output, never a captured original or a similarly named file. */
export async function resolveAutomaticEditingContext(input: {
	prisma: Pick<AppPrismaClient, "libraryAnalysisBinding">;
	organizationId: string;
	source: Source;
	outputs: readonly AutomaticEditingOutput[];
	mediaVersions: readonly LibraryMediaVersion[];
	analyses: readonly Analysis[];
	readOutputIdentity: (
		output: AutomaticEditingOutput,
	) => Promise<ObjectIdentity>;
	candidateLimitExceeded?: boolean;
}): Promise<AutomaticEditingContext> {
	const { source, organizationId } = input;
	const empty: AutomaticEditingContext = {
		encodingId: source.encodingId,
		status: "UNAVAILABLE",
		analysisRevisionId: null,
		mediaVersionId: null,
		hasAudio: null,
		preparation: null,
		reason: null,
	};
	if (
		source.organizationId !== organizationId ||
		source.sourceKind !== "VOD_JOB" ||
		!source.encodingId
	)
		return { ...empty, reason: "NO_ENCODING_SOURCE" };
	if (input.candidateLimitExceeded)
		return { ...empty, reason: "ANALYSIS_BINDING_LIMIT" };
	const outputs = input.outputs.filter(
		(output) => output.kind === "MP4" || output.kind === "HLS",
	);
	const analyses = input.analyses
		.filter(
			(analysis) =>
				analysis.organizationId === organizationId &&
				analysis.sourceId === source.id,
		)
		.toSorted((a, b) => Number(b.locale === "en") - Number(a.locale === "en"));
	const outputFor = (media: LibraryMediaVersion) => {
		const storage = editingMediaStorageSchema.safeParse(media.storage);
		if (
			!storage.success ||
			media.organizationId !== organizationId ||
			media.sourceId !== source.id
		)
			return undefined;
		return outputs.find(
			(output) =>
				output.credentialId === storage.data.source.credentialId &&
				output.bucket === storage.data.source.bucket &&
				output.path === storage.data.source.key,
		);
	};
	const located = input.mediaVersions.filter(
		(row) =>
			["READY", "PENDING", "RUNNING"].includes(row.state) && outputFor(row),
	);
	const locatorKey = (output: AutomaticEditingOutput) =>
		JSON.stringify([output.credentialId, output.bucket, output.path]);
	const targets = new Map(
		located.flatMap((row) => {
			const output = outputFor(row);
			return output ? [[locatorKey(output), output] as const] : [];
		}),
	);
	if (targets.size > 8) return { ...empty, reason: "OUTPUT_IDENTITY_LIMIT" };
	const identities = new Map(
		await Promise.all(
			[...targets].map(async ([key, output]) => {
				try {
					return [key, await input.readOutputIdentity(output)] as const;
				} catch {
					return [key, null] as const;
				}
			}),
		),
	);
	const media = located.filter((row) => {
		const storage = editingMediaStorageSchema.parse(row.storage);
		const output = outputFor(row);
		const current = output ? identities.get(locatorKey(output)) : undefined;
		const expected = storage.source.expect;
		if (
			!current ||
			!expected ||
			!Number.isSafeInteger(current.size) ||
			current.size <= 0 ||
			storage.source.size !== current.size
		)
			return false;
		const fields = ["etag", "versionId", "generation"] as const;
		const pinned = fields.filter(
			(field) =>
				!!expected[field] &&
				!(field === "versionId" && expected[field] === "null"),
		);
		return (
			pinned.length > 0 &&
			pinned.every((field) => expected[field] === current[field])
		);
	});
	const identityReadFailed = [...identities.values()].some(
		(identity) => identity === null,
	);
	const ready = media.filter((row) => row.state === "READY");
	const pending = media.find(
		(row) => row.state === "PENDING" || row.state === "RUNNING",
	);
	const target = outputs[0];
	const preparation = target
		? {
				fileKey: target.key,
				output: {
					credentialId: target.credentialId,
					bucket: target.bucket,
					prefix:
						posix.dirname(target.path) === "."
							? ""
							: posix.dirname(target.path),
				},
			}
		: null;
	const base = { ...empty, preparation };
	if (!analyses.length)
		return { ...base, status: "ANALYSIS_PENDING", reason: "NO_ANALYSIS" };
	const selectedAnalysis = analyses[0];
	if (!selectedAnalysis)
		return { ...base, status: "ANALYSIS_PENDING", reason: "NO_ANALYSIS" };
	const withAnalysis = { ...base, analysisRevisionId: selectedAnalysis.id };
	const hasAudio = (row: LibraryMediaVersion): boolean | null => {
		const probe =
			row.probe && typeof row.probe === "object" && !Array.isArray(row.probe)
				? (row.probe as { streams?: unknown })
				: {};
		if (
			!Array.isArray(probe.streams) ||
			!probe.streams.some(
				(stream) =>
					stream && typeof stream === "object" && stream.codec_type === "video",
			)
		)
			return null;
		return probe.streams.some(
			(stream) =>
				stream && typeof stream === "object" && stream.codec_type === "audio",
		);
	};
	if (ready.length) {
		const bindings = await input.prisma.libraryAnalysisBinding.findMany({
			where: {
				organizationId,
				mediaVersionId: { in: ready.map((row) => row.id) },
				analysisRevisionId: { in: analyses.map((row) => row.id) },
			},
			take: 101,
		});
		if (bindings.length > 100)
			return { ...withAnalysis, reason: "ANALYSIS_BINDING_LIMIT" };
		for (const analysis of analyses)
			for (const version of ready) {
				try {
					verifyAutomaticAnalysisBinding({
						organizationId,
						media: version,
						analysis,
						bindings: bindings
							.filter(
								(row) =>
									row.organizationId === organizationId &&
									row.mediaVersionId === version.id &&
									row.analysisRevisionId === analysis.id,
							)
							.map((row) => row.proof),
					});
					return {
						...base,
						status: "READY",
						analysisRevisionId: analysis.id,
						mediaVersionId: version.id,
						hasAudio: hasAudio(version),
					};
				} catch {
					/* An unverified pair may still be reviewed explicitly in this flow. */
				}
			}
		const version = ready[0];
		if (version)
			return {
				...withAnalysis,
				status: "NEEDS_CONFIRMATION",
				mediaVersionId: version.id,
				hasAudio: hasAudio(version),
				reason: "ANALYSIS_BINDING_UNVERIFIED",
			};
	}
	if (identityReadFailed)
		return { ...withAnalysis, reason: "OUTPUT_IDENTITY_UNVERIFIED" };
	if (pending)
		return { ...withAnalysis, status: "PREPARING", mediaVersionId: pending.id };
	return preparation
		? { ...withAnalysis, status: "NEEDS_PREPARATION" }
		: { ...withAnalysis, reason: "NO_EDITABLE_OUTPUT" };
}

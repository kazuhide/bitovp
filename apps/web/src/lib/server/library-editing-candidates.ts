import "server-only";
import type {
	AppPrismaClient,
	LibraryMediaVersion,
	SceneAnalysisRevision,
} from "@bitovp/db";
import type { ObjectIdentity, ObjectStorageBrowser } from "@bitovp/storage";
import type { ServerContext } from "./context";
import type { AutomaticEditingOutput } from "./library-editing-context";
import { browserForCredentialId } from "./storage";

type Analysis = Pick<
	SceneAnalysisRevision,
	| "id"
	| "organizationId"
	| "sourceId"
	| "locale"
	| "rawHash"
	| "document"
	| "providerVersion"
	| "createdAt"
>;
const analysisSelect = {
	id: true,
	organizationId: true,
	sourceId: true,
	locale: true,
	rawHash: true,
	document: true,
	providerVersion: true,
	createdAt: true,
} as const;
const unique = <T extends { id: string }>(rows: readonly T[]): T[] => [
	...new Map(rows.map((row) => [row.id, row])).values(),
];

/** Bound pairs and live preparation state are independent of the displayed mixed history. */
export async function loadAutomaticEditingCandidates(input: {
	prisma: AppPrismaClient;
	organizationId: string;
	source: {
		id: string;
		organizationId: string;
		sourceKind: string;
		encodingId: string | null;
	};
	recentAnalyses: readonly Analysis[];
}): Promise<{
	media: LibraryMediaVersion[];
	analyses: Analysis[];
	limitExceeded: boolean;
}> {
	const { source, organizationId, prisma } = input;
	if (
		source.organizationId !== organizationId ||
		source.sourceKind !== "VOD_JOB" ||
		!source.encodingId
	)
		return {
			media: [],
			analyses: [...input.recentAnalyses],
			limitExceeded: false,
		};
	const bound = await prisma.libraryAnalysisBinding.findMany({
		where: {
			organizationId,
			mediaVersion: { sourceId: source.id, state: "READY" },
			analysisRevision: { sourceId: source.id },
		},
		orderBy: { createdAt: "desc" },
		take: 101,
		select: { mediaVersionId: true, analysisRevisionId: true },
	});
	if (bound.length > 100)
		return { media: [], analyses: [], limitExceeded: true };
	const mediaIds = [...new Set(bound.map((row) => row.mediaVersionId))];
	const analysisIds = [...new Set(bound.map((row) => row.analysisRevisionId))];
	const where = { organizationId, sourceId: source.id };
	const [boundMedia, ready, active, boundAnalyses] = await Promise.all([
		mediaIds.length
			? prisma.libraryMediaVersion.findMany({
					where: { ...where, state: "READY", id: { in: mediaIds } },
					take: 100,
				})
			: [],
		prisma.libraryMediaVersion.findMany({
			where: { ...where, state: "READY" },
			orderBy: { createdAt: "desc" },
			take: 25,
		}),
		prisma.libraryMediaVersion.findMany({
			where: { ...where, state: { in: ["PENDING", "RUNNING"] } },
			orderBy: { createdAt: "desc" },
			take: 1,
		}),
		analysisIds.length
			? prisma.sceneAnalysisRevision.findMany({
					where: { ...where, id: { in: analysisIds } },
					select: analysisSelect,
					take: 100,
				})
			: [],
	]);
	return {
		media: unique([...boundMedia, ...ready, ...active]),
		analyses: unique([...input.recentAnalyses, ...boundAnalyses]),
		limitExceeded: false,
	};
}

/** Same SDK timeout on each driver; settle the in-flight HEAD before returning. */
export async function readAutomaticEditingOutputIdentity(
	ctx: ServerContext,
	output: AutomaticEditingOutput,
): Promise<ObjectIdentity> {
	const timeoutMs = 5_000;
	let browser: ObjectStorageBrowser | null = null;
	let expired = false;
	let disposed = false;
	const dispose = () => {
		if (browser && !disposed) {
			disposed = true;
			browser.dispose?.();
		}
	};
	const timer = setTimeout(() => {
		expired = true;
		dispose();
	}, timeoutMs);
	try {
		browser = await browserForCredentialId(
			ctx,
			output.credentialId,
			undefined,
			{ readTimeoutMs: timeoutMs },
		);
		if (expired || !browser?.headObject)
			throw new Error("OUTPUT_IDENTITY_UNVERIFIED");
		const identity = await browser.headObject({
			bucket: output.bucket,
			key: output.path,
		});
		if (expired) throw new Error("OUTPUT_IDENTITY_UNVERIFIED");
		return identity;
	} finally {
		clearTimeout(timer);
		dispose();
	}
}

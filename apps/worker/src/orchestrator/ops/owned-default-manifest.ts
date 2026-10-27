import type { DashManifest } from "@bitmovin/api-sdk";
import { verificationRequestSha256 } from "@bitovp/core";
import type { OpsContext } from "./context";
import {
	adoptOrCreateManifest,
	findUniqueManifestByOutput,
	ManifestCreateNotAuthorizedError,
} from "./shared";

type ManifestRequest = {
	manifestName?: string;
	outputs?: DashManifest["outputs"];
	customData?: unknown;
};
type ManifestApi<Request extends ManifestRequest> = {
	label: string;
	path: string;
	encodingId: string;
	request: (value: Partial<Request>) => Request;
	list: (query: {
		limit: number;
		offset: number;
		sort: string;
		encodingId: string;
	}) => Promise<{
		items?: Pick<DashManifest, "id" | "manifestName" | "outputs">[];
	}>;
	customData: (id: string) => Promise<{ customData?: unknown }>;
	create: (request: Request) => Promise<{ id?: string }>;
	auditSelection: (request: Request) => Record<string, unknown>;
};

/** Bind a complete default-manifest wire request to its owned job step. */
export async function createOwnedDefaultManifest<
	Request extends ManifestRequest,
>(
	ctx: OpsContext,
	params: { strictIdentity?: boolean; allowCreate?: boolean },
	source: Request,
	api: ManifestApi<Request>,
): Promise<string> {
	const { label } = api;
	const stamp = ctx.options.stamp;
	const step = stamp?.currentStep();
	if (stamp && (!stamp.jobId || !step))
		throw new Error(
			`${label} manifest requires a complete job and step identity`,
		);
	if (!stamp && params.strictIdentity)
		throw new Error(
			`${label} manifest ownership cannot be proven without a job and step identity`,
		);
	// RestClient omits null values and empty arrays. Snapshot before the first await.
	const snapshot: Partial<Request> = JSON.parse(
		JSON.stringify(source, (_key, value) =>
			value == null || (Array.isArray(value) && value.length === 0)
				? undefined
				: value,
		),
	);
	const request = api.request(snapshot);
	const requestSha256 = verificationRequestSha256(snapshot);
	const owner =
		stamp && step
			? {
					job: stamp.jobId,
					step,
					manifestRequestSha256: requestSha256,
					...(stamp.verification
						? { verification: { ...stamp.verification } }
						: {}),
				}
			: undefined;
	const wireRequest = owner
		? api.request({ ...request, customData: { bitovp: owner } })
		: request;
	const destination = request.outputs?.[0];
	const matchesDestination = (
		manifest: Pick<DashManifest, "manifestName" | "outputs">,
	) =>
		manifest.manifestName === request.manifestName &&
		(manifest.outputs ?? []).some(
			(output) =>
				output.outputId === destination?.outputId &&
				output.outputPath === destination?.outputPath,
		);
	const lookup = async () => {
		// An unstamped caller may create, but cannot prove ownership of an old resource.
		if (!owner) return undefined;
		const existing = await findUniqueManifestByOutput(
			async (query) => {
				const result = await api.list({ ...query, encodingId: api.encodingId });
				const items: { id?: string; owned: boolean }[] = [];
				for (const manifest of result.items ?? []) {
					if (!matchesDestination(manifest)) {
						items.push({ id: manifest.id, owned: false });
						continue;
					}
					if (!manifest.id)
						throw new Error(
							`${label} manifest identity lookup returned a candidate without an ID`,
						);
					const data = await api.customData(manifest.id);
					const marker = bag(bag(data.customData)?.bitovp);
					const ownsStep =
						marker?.job === owner.job && marker?.step === owner.step;
					if (ownsStep) {
						const verification = bag(marker?.verification);
						if (
							marker?.manifestRequestSha256 !== owner.manifestRequestSha256 ||
							(owner.verification &&
								(verification?.key !== owner.verification.key ||
									verification?.requestSha256 !==
										owner.verification.requestSha256))
						)
							throw new Error(
								`${label} manifest request identity conflict: the owned step has different or incomplete settings`,
							);
					}
					items.push({ id: manifest.id, owned: ownsStep });
				}
				return { items };
			},
			(manifest) => manifest.owned,
			label,
		);
		if (!existing && stamp?.adoptWindow?.() === true)
			throw new Error(
				`${label} manifest crash window is unresolved; no matching owned request is visible`,
			);
		return existing;
	};
	return adoptOrCreateManifest({
		label,
		lookup,
		strictLookup: true,
		allowCreate:
			params.allowCreate !== false && stamp?.allowCreate?.() !== false,
		auditAdopt: (resourceId, phase) =>
			ctx.record({
				method: "GET",
				path: api.path,
				statusCode: 200,
				durationMs: 0,
				bitmovinAccountId: ctx.options.bitmovinAccountId,
				request: {
					adopted: request.manifestName,
					phase,
					requestSha256,
					...api.auditSelection(request),
				},
				response: { id: resourceId },
			}),
		create: () => {
			// Cancellation may arrive while provider identity is being read.
			if (params.allowCreate === false || stamp?.allowCreate?.() === false)
				throw new ManifestCreateNotAuthorizedError(label);
			return ctx
				.audited(
					"POST",
					`${api.path}/default`,
					snapshot,
					() => api.create(wireRequest),
					(result) => ({ id: result.id }),
				)
				.then(ctx.id);
		},
	});
}

function bag(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

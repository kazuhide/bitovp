import { z } from "zod";

export const operationScopes = ["vod", "live", "settings", "shared"] as const;
const verbs = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
] as const;
const anchor = z.string().trim().min(1);
const sourceAnchor = z.strictObject({ file: z.string().min(1), anchor });
const operationProof = z.strictObject({
	sdkMethod: z.string().startsWith("encoding."),
	httpVerb: z.enum(verbs),
	path: z.string().startsWith("/encoding/"),
	scope: z.enum(operationScopes),
	scenario: z.string().trim().min(1),
	entrypoint: z.strictObject({
		httpVerb: z.enum(verbs),
		path: z.string().regex(/^\/api(?:\/[a-z0-9-]+|\/\[[a-zA-Z0-9_-]+\])+$/),
		anchor,
	}),
	transport: sourceAnchor,
	contractTest: sourceAnchor,
	provider: z.literal("unverified"),
});

export type OperationProof = z.infer<typeof operationProof>;
type OperationIdentity = { sdkMethod: string; httpVerb: string; path: string };
type SourceEndpoint = OperationIdentity & {
	status: string;
	evidence: { file: string; line: number }[];
};
export type CoverageEndpoint = SourceEndpoint & {
	family: string;
	operation: string;
};
type Census = {
	provenance: { sdkVersion: string };
	endpoints: SourceEndpoint[];
};
type Audit = { schemaVersion: number; sdkVersion: string; operations: unknown };

export type OperationEvidence =
	| {
			reachability: "app-confirmed";
			contract: "transport-confirmed";
			provider: "unverified";
			proof: OperationProof;
	  }
	| {
			reachability: "unreviewed";
			contract: "unverified";
			provider: "unverified";
			proof: null;
	  };

export type OperationLedger = {
	schemaVersion: 1;
	sdkVersion: string;
	summary: {
		total: number;
		appConfirmed: number;
		transportConfirmed: number;
		providerVerified: number;
		unreviewed: number;
	};
	operations: Record<string, OperationEvidence>;
};

const unreviewed: OperationEvidence = {
	reachability: "unreviewed",
	contract: "unverified",
	provider: "unverified",
	proof: null,
};

export function sameOperation(a: OperationIdentity, b: OperationIdentity) {
	return (
		a.sdkMethod === b.sdkMethod &&
		a.httpVerb === b.httpVerb &&
		a.path === b.path
	);
}

export function readOperationProofs(census: Census, audit: Audit) {
	if (
		audit.schemaVersion !== 2 ||
		audit.sdkVersion !== census.provenance.sdkVersion
	) {
		throw new Error("Unsupported operation proof version or stale SDK");
	}
	const parsed = z.array(operationProof).safeParse(audit.operations);
	if (!parsed.success)
		throw new Error(`Invalid operation proof: ${parsed.error.message}`);
	const endpoints = new Map(
		census.endpoints.map((endpoint) => [endpoint.sdkMethod, endpoint]),
	);
	const proofs = new Map<string, OperationProof>();
	for (const proof of parsed.data) {
		const endpoint = endpoints.get(proof.sdkMethod);
		if (!endpoint || !sameOperation(endpoint, proof)) {
			throw new Error(
				`Unknown operation proof: ${proof.sdkMethod} ${proof.httpVerb} ${proof.path}`,
			);
		}
		if (proofs.has(proof.sdkMethod))
			throw new Error(`Duplicate operation proof: ${proof.sdkMethod}`);
		if (
			endpoint.status !== "source-confirmed" ||
			!endpoint.evidence.some(({ file }) => file === proof.transport.file)
		) {
			throw new Error(
				`Operation proof lacks resolved transport evidence: ${proof.sdkMethod}`,
			);
		}
		proofs.set(proof.sdkMethod, proof);
	}
	return proofs;
}

export function buildOperationLedger(
	census: Census,
	audit: Audit,
	installedSdk: string,
): OperationLedger {
	let proofs = new Map<string, OperationProof>();
	if (installedSdk === census.provenance.sdkVersion) {
		try {
			proofs = readOperationProofs(census, audit);
		} catch {
			// CI reports invalid evidence. A stale or invalid bundle must not show confirmation.
		}
	}
	const operations = Object.fromEntries(
		census.endpoints.map(({ sdkMethod }) => {
			const proof = proofs.get(sdkMethod);
			const evidence: OperationEvidence = proof
				? {
						reachability: "app-confirmed",
						contract: "transport-confirmed",
						provider: proof.provider,
						proof,
					}
				: unreviewed;
			return [sdkMethod, evidence];
		}),
	);
	return {
		schemaVersion: 1,
		sdkVersion: census.provenance.sdkVersion,
		summary: {
			total: census.endpoints.length,
			appConfirmed: proofs.size,
			transportConfirmed: proofs.size,
			providerVerified: 0,
			unreviewed: census.endpoints.length - proofs.size,
		},
		operations,
	};
}

export function operationEvidence(
	ledger: OperationLedger | undefined,
	sdkMethod: string,
) {
	return ledger?.operations[sdkMethod] ?? unreviewed;
}

export function filterCoverageOperations(
	endpoints: CoverageEndpoint[],
	ledger: OperationLedger | undefined,
	filters: {
		family: string;
		source: string;
		reachability: string;
		scope: string;
		q: string;
	},
) {
	const query = filters.q.trim().toLowerCase();
	return endpoints.filter((row) => {
		const evidence = operationEvidence(ledger, row.sdkMethod);
		if (filters.family && row.family !== filters.family) return false;
		if (filters.source && row.status !== filters.source) return false;
		if (filters.reachability && evidence.reachability !== filters.reachability)
			return false;
		if (filters.scope && evidence.proof?.scope !== filters.scope) return false;
		return (
			!query ||
			[
				`${row.httpVerb} ${row.path}`,
				row.operation,
				row.sdkMethod,
				row.family,
				...row.evidence.map((e) => `${e.file}:${e.line}`),
				evidence.proof?.scenario,
				evidence.proof?.entrypoint.path,
			]
				.join(" ")
				.toLowerCase()
				.includes(query)
		);
	});
}

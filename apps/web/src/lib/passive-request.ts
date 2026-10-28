export const EXPECTED_ORGANIZATION_QUERY = "expectedOrganizationId";
const UUID = "[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}";
const ORGANIZATION_ID = new RegExp(`^${UUID}$`);
const PASSIVE_PATH = new RegExp(
	`^/api/(?:library/sources/${UUID}/media|vmaf-jobs/${UUID}/preview|encoding-jobs/${UUID}/qc-report)$`,
);
const LIBRARY_MEDIA_PATH = new RegExp(`^/api/library/sources/${UUID}/media$`);

/** Only these native media/download reads may carry the document's organization in their URL. */
export function passiveRequestPath(pathname: string, method: string) {
	return (method === "GET" || method === "HEAD") && PASSIVE_PATH.test(pathname);
}

export type PassiveOrganizationBinding =
	| { kind: "absent" }
	| { kind: "invalid" }
	| { kind: "bound"; organizationId: string };

export function passiveOrganizationBinding(
	url: URL,
	method: string,
): PassiveOrganizationBinding {
	if (!passiveRequestPath(url.pathname, method)) return { kind: "absent" };
	const values = url.searchParams.getAll(EXPECTED_ORGANIZATION_QUERY);
	if (!values.length) return { kind: "absent" };
	const value = values[0];
	return values.length === 1 && value && ORGANIZATION_ID.test(value)
		? { kind: "bound", organizationId: value }
		: { kind: "invalid" };
}

/** A consistency assertion, never an authentication credential or an organization selector. */
export function bindPassiveRequestUrl(value: string, organizationId: string) {
	const url = relativePassiveUrl(value);
	if (!url || !ORGANIZATION_ID.test(organizationId))
		throw new Error("Invalid passive request binding");
	const binding = passiveOrganizationBinding(url, "GET");
	if (
		binding.kind === "invalid" ||
		(binding.kind === "bound" && binding.organizationId !== organizationId)
	)
		throw new Error("Conflicting passive request binding");
	url.searchParams.set(EXPECTED_ORGANIZATION_QUERY, organizationId);
	return `${url.pathname}${url.search}`;
}

function relativePassiveUrl(value: string): URL | null {
	if (!value.startsWith("/") || value.startsWith("//")) return null;
	const url = new URL(value, "http://passive.invalid");
	if (
		url.origin !== "http://passive.invalid" ||
		url.hash ||
		url.pathname !== value.split("?")[0] ||
		!passiveRequestPath(url.pathname, "GET")
	)
		return null;
	return url;
}

/** Keep catalog classification and one-byte diagnostics on the same exact local media route. */
export function isLibraryMediaUrl(value: string) {
	const url = relativePassiveUrl(value);
	if (!url || !LIBRARY_MEDIA_PATH.test(url.pathname)) return false;
	const key = url.searchParams.get("key");
	return (
		url.searchParams.getAll("key").length === 1 &&
		key !== null &&
		key.length <= 160 &&
		/^[A-Za-z0-9_.!~*'()%:-]+$/.test(key) &&
		[...url.searchParams.keys()].every(
			(name) => name === "key" || name === EXPECTED_ORGANIZATION_QUERY,
		) &&
		passiveOrganizationBinding(url, "GET").kind !== "invalid"
	);
}

/** Require the organization resolved by the server request before producing a native URL. */
export function requestOrganizationId(ctx: {
	tenant?: { organizationId: string };
}): string {
	const organizationId = ctx.tenant?.organizationId;
	if (!organizationId || !ORGANIZATION_ID.test(organizationId))
		throw new Error("Authenticated organization is unavailable");
	return organizationId;
}

"use client";

const EXPECTED_ORG = "x-bitovp-expected-org";
export const ORGANIZATION_CHANGE_KEY = "bitovp.organization-change";
let installed = false;

/** Pin browser requests to the organization that rendered this document. */
export function installTenantFetch(organizationId?: string) {
	if (installed || typeof window === "undefined" || !organizationId) return;
	installed = true;
	const original = window.fetch.bind(window);
	window.fetch = (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			window.location.href,
		);
		if (
			url.origin !== window.location.origin ||
			!url.pathname.startsWith("/api/")
		)
			return original(input, init);
		const headers = new Headers(
			input instanceof Request ? input.headers : undefined,
		);
		new Headers(init?.headers).forEach((value, key) => {
			headers.set(key, value);
		});
		headers.set(EXPECTED_ORG, organizationId);
		return original(input, { ...init, headers });
	};
}

export function reloadAfterOrganizationChange() {
	try {
		localStorage.setItem(
			ORGANIZATION_CHANGE_KEY,
			`${Date.now()}:${crypto.randomUUID()}`,
		);
	} catch {
		/* Private browsing still reloads this tab. */
	}
	window.location.assign("/");
}

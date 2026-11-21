"use client";

const EXPECTED_ORG = "x-bitovp-expected-org";
const IDENTITY_CHANGE_WAIT_MS = 250;
const IDENTITY_CHANGE_POSTS = new Set([
	"/api/auth/logout",
	"/api/account/organization",
	"/api/account/impersonation",
]);
export const ORGANIZATION_CHANGE_KEY = "bitovp.organization-change";
type IdentityChangeCleanup = () => Promise<unknown> | undefined;
const identityChangeCleanups = new Set<IdentityChangeCleanup>();
let installed = false;
let identityChangeWait: Promise<unknown> | undefined;

export function registerBeforeIdentityChange(cleanup: IdentityChangeCleanup) {
	identityChangeCleanups.add(cleanup);
	return () => {
		identityChangeCleanups.delete(cleanup);
	};
}

function waitForIdentityChangeCleanups() {
	if (identityChangeWait) return identityChangeWait;
	const pending: Promise<unknown>[] = [];
	for (const cleanup of identityChangeCleanups) {
		try {
			const result = cleanup();
			if (result) pending.push(result);
		} catch {
			// A best-effort cleanup cannot prevent changing identity.
		}
	}
	if (pending.length === 0) return;
	let timer: number | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = window.setTimeout(resolve, IDENTITY_CHANGE_WAIT_MS);
	});
	identityChangeWait = Promise.race([
		Promise.allSettled(pending),
		deadline,
	]).finally(() => {
		window.clearTimeout(timer);
		identityChangeWait = undefined;
	});
	return identityChangeWait;
}

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
		const options = { ...init, headers };
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (
			(method === "POST" && IDENTITY_CHANGE_POSTS.has(url.pathname)) ||
			(method === "DELETE" && url.pathname === "/api/account/impersonation")
		) {
			const wait = waitForIdentityChangeCleanups();
			if (wait) return wait.then(() => original(input, options));
		}
		return original(input, options);
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

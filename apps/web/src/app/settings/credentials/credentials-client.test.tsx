import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

import { CredentialsClient } from "./credentials-client";

/**
 * `?new=1` — the wizards' way in (owner request 2026-08-19).
 *
 * The link that sends an operator here is pinned in
 * `components/ui/new-credential-link.test.tsx`; this is the other end. Both
 * halves need a test, because a correct link into a page that ignores the
 * query is the same dead end as no link at all.
 */
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => search.value,
}));

const rows = vi.hoisted(() => ({
	value: [] as {
		id: string;
		label: string;
		provider: string;
		config: object;
		hasSecret: boolean;
	}[],
}));
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: vi.fn(async () => rows.value),
}));

function render(query: string) {
	search.value = new URLSearchParams(query);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	renderL(
		<QueryClientProvider client={client}>
			<CredentialsClient />
		</QueryClientProvider>,
	);
}

describe("the credentials screen's deep link", () => {
	it("opens the add dialog when ?new=1 is present", () => {
		render("new=1");
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("stays closed otherwise — the list is the default landing", () => {
		render("");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("ignores a value that is not exactly 1, rather than any truthy string", () => {
		// `?new=0` and `?new=false` both read as "do not open" to a human, and
		// a bare presence check would open on both.
		for (const q of ["new=0", "new=false", "new="]) {
			render(q);
			expect(screen.queryByRole("dialog"), q).toBeNull();
		}
	});
});

describe("credentials are grouped by PURPOSE, not all called storage (ledger #141)", () => {
	/**
	 * The owner raised this twice: the screen said "Storage credentials" and
	 * listed a DRM content key. It also listed live-ingest secrets and four
	 * integration endpoints — the DRM one was simply the most visibly wrong.
	 */
	function withCredentials(
		list: { provider: string; label: string; hasSecret?: boolean }[],
	): void {
		rows.value = list.map((c, i) => ({
			id: `c${i}`,
			label: c.label,
			provider: c.provider,
			config: {},
			// : the server's per-row answer. Defaulted TRUE so the
			// grouping arms below — which are about headings, not badges — stay
			// unchanged; the badge arms state it explicitly, both ways.
			hasSecret: c.hasSecret ?? true,
		}));
		render("");
	}

	it("files a DRM content key under DRM, not under Storage", async () => {
		withCredentials([
			{ provider: "AWS_S3", label: "prod bucket" },
			{ provider: "DRM_CENC", label: "title key" },
		]);
		const storage = await screen.findByRole("heading", { name: "Storage" });
		const drm = await screen.findByRole("heading", { name: "DRM" });
		// The key must be under DRM's heading — asserting both headings exist
		// would pass even if every row sat in one list.
		const drmList = drm.nextElementSibling as HTMLElement;
		const storageList = storage.nextElementSibling as HTMLElement;
		expect(within(drmList).getByText("title key")).toBeTruthy();
		expect(within(storageList).queryByText("title key")).toBeNull();
		expect(within(storageList).getByText("prod bucket")).toBeTruthy();
	});

	it("shows no empty headings — a fresh install still reads as one list", async () => {
		withCredentials([{ provider: "AWS_S3", label: "only one" }]);
		await screen.findByRole("heading", { name: "Storage" });
		expect(screen.queryByRole("heading", { name: "DRM" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "Live ingest" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "Integrations" })).toBeNull();
	});

	it("no longer calls the screen Storage", async () => {
		withCredentials([{ provider: "AWS_S3", label: "x" }]);
		const title = await screen.findByRole("heading", { level: 1 });
		expect(title.textContent).toBe("Credentials");
	});

	/**
	 * "Secret configured" is a claim about the ROW — , and this arm
	 * has now been rewritten twice by the same finding getting sharper.
	 *
	 * v1 (security F13): the badge rendered unconditionally, so the two
	 * providers with an empty `secret` array advertised a secret they cannot
	 * hold. v2 keyed on `PROVIDER_FIELDS[provider].secret.length > 0` — correct
	 * for all 18 providers that day, and a lie one PR later, because MSL5's
	 * Digest pair makes `AKAMAI_MSL` a provider whose rows DISAGREE with each
	 * other.
	 *
	 * WHICH IS THE PROPERTY THIS ARM COULD NOT EXPRESS BEFORE, and now does:
	 * two rows of the SAME provider, one badged and one not. Under v2 that was
	 * unrepresentable — the condition read the provider, so same provider meant
	 * same answer, always. A test that cannot state the defect cannot catch it.
	 *
	 * Asserted by RELATION (`within(row)`), so a badge rendered on the wrong row
	 * cannot pass by being present somewhere on the page.
	 */
	it("badges two rows of the SAME provider differently, per row", async () => {
		withCredentials([
			{ provider: "AKAMAI_MSL", label: "msl5 with digest", hasSecret: true },
			{ provider: "AKAMAI_MSL", label: "msl4 no digest", hasSecret: false },
		]);
		const withSecret = (await screen.findByText("msl5 with digest")).closest(
			"li",
		) as HTMLElement;
		const withoutSecret = (await screen.findByText("msl4 no digest")).closest(
			"li",
		) as HTMLElement;
		// Both rows must actually be on screen — otherwise the negative below
		// passes because the row is missing, not because the badge is.
		expect(withSecret).toBeTruthy();
		expect(withoutSecret).toBeTruthy();
		expect(within(withSecret).getByText("secret configured")).toBeTruthy();
		expect(within(withoutSecret).queryByText("secret configured")).toBeNull();
	});

	/**
	 * The F13 case still holds, now for an honest reason rather than a
	 * structural one: `AWS_S3_ROLE_BASED` has no secret, so the server reports
	 * `hasSecret: false` and the badge stays away. Same outcome as v2, arrived
	 * at by looking at the row instead of inferring from the provider.
	 */
	it("stays away from a provider that genuinely has no secret", async () => {
		withCredentials([
			{ provider: "AWS_S3", label: "has one", hasSecret: true },
			{ provider: "AWS_S3_ROLE_BASED", label: "role based", hasSecret: false },
		]);
		const roleBased = (await screen.findByText("role based")).closest(
			"li",
		) as HTMLElement;
		expect(roleBased).toBeTruthy();
		expect(within(roleBased).queryByText("secret configured")).toBeNull();
	});
});

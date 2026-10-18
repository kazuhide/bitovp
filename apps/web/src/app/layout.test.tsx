import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from "@/lib/i18n";

/**
 * `<html lang>` had no test, and I nearly shipped it claiming otherwise.
 *
 * Replacing `lang={locale}` with a hard-coded `lang="en"` left all 60 tests in
 * the i18n, components and login suites green. That attribute is the load-bearing
 * part of resolving the locale on the SERVER at all — it is what a screen reader
 * announces with and what suppresses the browser's "translate this page?" prompt
 * on a page that is already in the reader's language. Without it, server-side
 * resolution buys only the absence of a hydration mismatch.
 *
 * The layout is an async server component, so `next/headers` is mocked and the
 * returned element tree is inspected directly rather than rendered — jsdom cannot
 * host an `<html>` element inside an existing document.
 */
const cookieJar = new Map<string, string>();
let acceptLanguage: string | null = null;

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
	headers: async () =>
		new Headers(
			acceptLanguage === null ? {} : { "accept-language": acceptLanguage },
		),
}));

// The layout imports ./globals.css, which would pull Tailwind's PostCSS pipeline
// into the test run and fail to load it. The stylesheet is irrelevant here.
vi.mock("./globals.css", () => ({}));

// The shell and providers pull in client-only chains; the assertions here are
// about the <html> element the layout returns, not its children.
vi.mock("@/components/app-shell", () => ({
	AppShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/providers", () => ({
	Providers: ({ children }: { children: unknown }) => children,
}));

const RootLayout = (await import("./layout")).default;

/** The `lang` prop of the returned `<html>`, without rendering it. */
async function langOf(): Promise<unknown> {
	const tree = await RootLayout({ children: null });
	return (tree as { props: { lang?: unknown } }).props.lang;
}

beforeEach(() => {
	cookieJar.clear();
	acceptLanguage = null;
});

describe("RootLayout", () => {
	it("resolves the appearance cookie into the first HTML response", async () => {
		cookieJar.set("bitovp-theme", "paper");
		const tree = await RootLayout({ children: null });
		expect(tree.props["data-theme"]).toBe("paper");
	});

	it("ignores an unknown appearance cookie", async () => {
		cookieJar.set("bitovp-theme", "invalid");
		const tree = await RootLayout({ children: null });
		expect(tree.props["data-theme"]).toBe("neon");
	});

	it("stamps the cookie's locale into <html lang>", async () => {
		cookieJar.set(LOCALE_COOKIE, "ja");
		expect(await langOf()).toBe("ja");
	});

	it("stamps a header-derived locale when there is no cookie", async () => {
		acceptLanguage = "ja-JP,en;q=0.8";
		expect(await langOf()).toBe("ja");
	});

	it("falls back to en with neither cookie nor usable header", async () => {
		acceptLanguage = "de-DE";
		expect(await langOf()).toBe("en");
	});

	it("lets the cookie override the header", async () => {
		cookieJar.set(LOCALE_COOKIE, "en");
		acceptLanguage = "ja";
		expect(await langOf()).toBe("en");
	});

	it("passes the same locale to the provider that it stamped on <html>", async () => {
		// Otherwise `lang` and the rendered copy could disagree — the failure this
		// whole server-side arrangement exists to prevent.
		cookieJar.set(LOCALE_COOKIE, "ja");
		const tree = (await RootLayout({ children: null })) as {
			props: { lang: string; children: { props: { children: unknown } } };
		};
		const body = tree.props.children as { props: { children: unknown } };
		const provider = body.props.children as { props: { locale: string } };
		expect(provider.props.locale).toBe(tree.props.lang);
	});
});

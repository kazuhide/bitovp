import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from ".";

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

const { localizedTitle } = await import("./metadata");

beforeEach(() => {
	cookieJar.clear();
	acceptLanguage = null;
});

/**
 * Page `<title>`s — the browser TAB — went unlocalized through three i18n commits
 * and were found only by running the app: with `ovp-locale=ja` the body rendered
 * Japanese while every tab still read English, because
 * `export const metadata = { title: "…" }` is static and cannot see the request.
 *
 * Nothing in the suite could have caught it, and that is the point of this file:
 * jsdom tests render COMPONENTS, not document metadata, so the only way to pin it
 * is to call the generator directly. 21 pages were affected.
 */
describe("localizedTitle", () => {
	it("returns the English title by default", async () => {
		expect(await localizedTitle("pageTitles.signIn")()).toEqual({
			title: "Sign in",
		});
	});

	it("returns the Japanese title when the cookie says so", async () => {
		cookieJar.set(LOCALE_COOKIE, "ja");
		expect(await localizedTitle("pageTitles.signIn")()).toEqual({
			title: "サインイン",
		});
	});

	it("falls back to Accept-Language when there is no cookie", async () => {
		acceptLanguage = "ja-JP,en;q=0.8";
		expect(await localizedTitle("pageTitles.dashboard")()).toEqual({
			title: "ダッシュボード",
		});
	});

	it("honours q=0 here too, not just in the layout", async () => {
		acceptLanguage = "ja;q=0, en";
		expect(await localizedTitle("pageTitles.dashboard")()).toEqual({
			title: "Dashboard",
		});
	});

	it("lets the cookie override the header", async () => {
		cookieJar.set(LOCALE_COOKIE, "en");
		acceptLanguage = "ja";
		expect(await localizedTitle("pageTitles.storage")()).toEqual({
			title: "Storage",
		});
	});

	/**
	 * Every page's key must exist. A typo would otherwise surface as a THROWN
	 * request — `translate` refuses to render a key as copy — and the first person to
	 * see it would be whoever opened that page.
	 */
	it("resolves every pageTitles key in both locales", async () => {
		const { en } = await import("./messages/en");
		const keys = Object.keys(en.pageTitles) as (keyof typeof en.pageTitles)[];
		expect(keys.length).toBeGreaterThanOrEqual(21);
		for (const key of keys) {
			cookieJar.set(LOCALE_COOKIE, "en");
			const enTitle = await localizedTitle(`pageTitles.${key}` as never)();
			cookieJar.set(LOCALE_COOKIE, "ja");
			const jaTitle = await localizedTitle(`pageTitles.${key}` as never)();
			expect(enTitle.title, key).toBeTruthy();
			expect(jaTitle.title, key).toBeTruthy();
		}
	});
});

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import {
	LOCALE_COOKIE,
	type MessageKey,
	messagesFor,
	resolveLocale,
	translate,
} from ".";

/**
 * Localized page titles, i.e. what the BROWSER TAB says.
 *
 * These were missed until the app was actually run: with `ovp-locale=ja` the page
 * body rendered Japanese while every `<title>` still read English, because
 * `export const metadata = { title: "Sign in" }` is evaluated statically and cannot
 * see the request's cookie. Twenty-one pages, all of them wrong, and nothing in the
 * suite could have caught it — jsdom tests render components, not document metadata.
 *
 * `generateMetadata` is the per-request form, so it can resolve the locale the same
 * way the root layout does. Making it async does not cost anything here: reading
 * cookies in the root layout already opted the whole app into dynamic rendering
 * (see the note in `app/layout.tsx`).
 *
 * The `%s · Bitmovin OVP` template lives in the root layout and still applies —
 * only the leading segment is localized, and the product name deliberately is not.
 */
export function localizedTitle(key: MessageKey) {
	return async function generateMetadata(): Promise<Metadata> {
		const [cookieStore, headerStore] = await Promise.all([
			cookies(),
			headers(),
		]);
		const locale = resolveLocale({
			cookie: cookieStore.get(LOCALE_COOKIE)?.value,
			acceptLanguage: headerStore.get("accept-language"),
		});
		return { title: translate(messagesFor(locale), key) };
	};
}

/**
 * The ROOT layout's metadata: the brand title template plus a localized
 * description. Separate from `localizedTitle` because this one sets the template
 * every page title fills, and the brand name itself stays verbatim.
 */
export function rootMetadata(descriptionKey: MessageKey, brand: string) {
	return async function generateMetadata(): Promise<Metadata> {
		const [cookieStore, headerStore] = await Promise.all([
			cookies(),
			headers(),
		]);
		const locale = resolveLocale({
			cookie: cookieStore.get(LOCALE_COOKIE)?.value,
			acceptLanguage: headerStore.get("accept-language"),
		});
		return {
			title: { default: brand, template: `%s · ${brand}` },
			description: translate(messagesFor(locale), descriptionKey),
		};
	};
}

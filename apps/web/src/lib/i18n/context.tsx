"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
	DEFAULT_LOCALE,
	LOCALE_COOKIE,
	type Locale,
	type MessageKey,
	messagesFor,
	translate,
} from ".";

export type Translator = (
	key: MessageKey,
	values?: Record<string, string | number>,
) => string;

const LocaleContext = createContext<{ locale: Locale; t: Translator } | null>(
	null,
);

/**
 * The locale arrives as a prop from the root layout, which read the cookie on
 * the server. It is NOT read from `document.cookie` here: doing that would make
 * the first client render disagree with the server's HTML and hydrate-mismatch
 * every translated string on the page.
 *
 * NOT here: `z.config(z.locales.ja)`, to translate Zod's own messages ("Too small:
 * expected string to have >=1 characters"), which do render on screen in the
 * wizards' plan preview.
 *
 * It was tried, and measured. `z.config` mutates a PROCESS-global, and Next
 * server-renders client components, so this provider runs on the server too: one
 * `ja` page render flipped the whole Node process to Japanese, which then came back
 * in `z.flattenError` from every API route — including for concurrent `en`
 * requests. Guarding it with `typeof window` fixes the bleed but re-introduces the
 * exact failure above: the server would render the English message and the client
 * the Japanese one, hydrate-mismatching user-visible text.
 *
 * So Zod's messages stay English AT THE SOURCE — they land in API responses, the
 * audit row and the process log, and one wording for the operator reading a log and
 * the operator reading a screen is worth more than a localized sentence in the
 * preview. The FORM layer's answer is `zod-issue-message.ts` ((c)): a
 * per-render choke point that maps the raw English — authored sentences by exact
 * match, zod defaults by issue code — through the catalogue with the component's
 * own `t`, so no process-global mutates and server text never changes.
 */
export function LocaleProvider({
	locale,
	children,
}: {
	locale: Locale;
	children: ReactNode;
}) {
	const value = useMemo(() => {
		const messages = messagesFor(locale);
		return {
			locale,
			t: ((key, values) => translate(messages, key, values)) as Translator,
		};
	}, [locale]);
	return (
		<LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
	);
}

/**
 * Throws outside a provider rather than falling back to English. A silent
 * fallback would render correct-looking copy in a subtree nobody knows is
 * un-localized — the same failure mode the catalogue's `satisfies` check exists
 * to prevent, reintroduced at the component layer.
 */
export function useT(): { locale: Locale; t: Translator } {
	const ctx = useContext(LocaleContext);
	if (!ctx) {
		throw new Error("useT must be used inside <LocaleProvider>");
	}
	return ctx;
}

/**
 * Persist a locale choice. `max-age` is two years and the cookie is deliberately
 * NOT `HttpOnly` — it carries a UI preference, nothing authenticating, and the
 * switcher needs to write it without a round trip. `SameSite=Lax` and `Path=/`
 * match the session cookie so a language choice survives following a link in.
 *
 * `Secure` is set only on https, for the same reason the session cookies are
 * per-name: a `Secure` cookie written from a non-trustworthy origin is ignored
 * (RFC 6265bis §5.7.3), which on a plain-http install would silently make the
 * switcher a no-op.
 */
export function persistLocale(locale: Locale): void {
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	// The async CookieStore API the rule prefers is Chromium-only — Safari and
	// Firefox would silently stop persisting the choice. Revisit when
	// cookieStore is baseline. (Single-line ignore: continuation lines broke
	// adjacency, so the suppression read "unused" WHILE the warning fired.)
	// biome-ignore lint/suspicious/noDocumentCookie: CookieStore is Chromium-only
	document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=63072000; SameSite=Lax${secure}`;
}

export { DEFAULT_LOCALE };

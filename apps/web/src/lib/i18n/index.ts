import { en, type MessageKey, type Messages } from "./messages/en";
import { ja } from "./messages/ja";

export type { MessageKey, Messages };

export const LOCALES = ["en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/**
 * The locale is a COOKIE, not a URL segment.
 *
 * A `/[locale]/…` prefix is the conventional App Router answer and is wrong for
 * this app: every path would move, which breaks the `config.matcher` the auth
 * gate is built on and would silently un-guard routes unless `gate-coverage`'s
 * expectations moved in lockstep. A UI-language preference is also not something
 * anyone here wants in a shareable link — a copied job URL should open on the
 * recipient's own language, not the sender's.
 */
export const LOCALE_COOKIE = "ovp-locale";

const CATALOGUES: Record<Locale, Messages> = { en, ja };

export function isLocale(value: unknown): value is Locale {
	return (
		typeof value === "string" && (LOCALES as readonly string[]).includes(value)
	);
}

/**
 * Resolve the active locale: an explicit cookie wins, then `Accept-Language`,
 * then English.
 *
 * The header parse is deliberately small — it reads tags in order and takes the
 * first one whose PRIMARY subtag we ship, so `ja-JP` matches `ja` and `en-GB`
 * matches `en`. It does NOT sort by q-value: a client sending
 * `ja;q=0.1, de;q=0.9` gets Japanese, because the alternative is German, which we
 * do not have, and honouring the ordering costs a parser for a preference the
 * cookie overrides the moment anyone disagrees with it.
 *
 * `q=0` IS honoured, and that is a different thing from a low q. RFC 9110 §12.5.4
 * gives it a specific meaning — "not acceptable" — so skipping the ordering is a
 * simplification while ignoring `q=0` was a bug: `ja;q=0, en` asked for anything
 * but Japanese and got Japanese, with English sitting right there in the same
 * header.
 */
export function resolveLocale(input: {
	cookie?: string | undefined;
	acceptLanguage?: string | null | undefined;
}): Locale {
	if (isLocale(input.cookie)) {
		return input.cookie;
	}
	for (const part of (input.acceptLanguage ?? "").split(",")) {
		const [rawTag, ...params] = part.split(";");
		const tag = rawTag?.trim().toLowerCase();
		if (!tag || isRejected(params)) {
			continue;
		}
		const primary = tag.split("-")[0];
		if (isLocale(primary)) {
			return primary;
		}
	}
	return DEFAULT_LOCALE;
}

/**
 * Does this tag carry `q=0`?
 *
 * A malformed q (`q=abc`) counts as NOT rejected: the tag was offered, and
 * refusing to serve a language because its quality value was unparsable would
 * turn a client's typo into a wrong-language page.
 */
function isRejected(params: string[]): boolean {
	for (const param of params) {
		const [name, value] = param.split("=");
		if (name?.trim().toLowerCase() !== "q") {
			continue;
		}
		const q = Number(value?.trim());
		return Number.isFinite(q) && q <= 0;
	}
	return false;
}

export function messagesFor(locale: Locale): Messages {
	return CATALOGUES[locale];
}

/**
 * Look up a dotted key and interpolate `{name}` placeholders.
 *
 * Throws on a missing key, and on an unfilled `{placeholder}` **whether or not a
 * `values` object was passed at all** — the second half is what the first version
 * of this claimed and did not do.
 *
 * Why throwing: in a repo whose gate coverage is a test that reads the
 * filesystem, "renders the raw key" is the same failure as "renders English" —
 * it looks like copy, so it survives review. The types make a bad key unreachable
 * from our own code, so a throw only fires for a dynamically-built key or a
 * placeholder nobody supplied, which are exactly the cases worth failing on.
 */
export function translate(
	messages: Messages,
	key: MessageKey,
	values?: Record<string, string | number>,
): string {
	let node: unknown = messages;
	for (const segment of key.split(".")) {
		if (typeof node !== "object" || node === null) {
			throw new Error(`[i18n] key "${key}" walks through a non-object`);
		}
		node = (node as Record<string, unknown>)[segment];
	}
	if (typeof node !== "string") {
		throw new Error(`[i18n] key "${key}" is not a string`);
	}
	// NO early return for a missing `values`, and that was a real bug rather than an
	// optimisation: every call site uses the bare `t("key")` form, so `if (!values)
	// return node` meant the first placeholder-bearing string added to the catalogue
	// would render `Hello {name}` to a user — precisely the copy-shaped output this
	// function throws to prevent. Three docs and this comment asserted it threw.
	// Latent only because no catalogue string carries a placeholder yet (review
	// catch).
	return node.replace(/\{(\w+)\}/g, (_match, name: string) => {
		const value = values?.[name];
		if (value === undefined) {
			throw new Error(`[i18n] key "${key}" has no value for {${name}}`);
		}
		return String(value);
	});
}

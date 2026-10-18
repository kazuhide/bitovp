import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { ThemeProvider } from "@/components/theme-provider";
import { ORGANIZATION_HEADER } from "@/lib/auth/tenancy";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/context";
import { rootMetadata } from "@/lib/i18n/metadata";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import { resolveTheme, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

export const generateMetadata = rootMetadata(
	"ui.guiFirstOnlineVideoPlatformExposingThe",
	"Bitmovin OVP",
);

/**
 * The locale is resolved HERE, on the server, and handed down as a prop. Two
 * things depend on that: `<html lang>` is correct in the first byte of HTML (so
 * a screen reader and the browser's own translation prompt agree with the copy),
 * and the client never re-derives it, which is what would hydrate-mismatch every
 * translated string.
 *
 * THE COST, measured rather than assumed: `cookies`/`headers` in the ROOT
 * layout opts the entire app into dynamic rendering. `pnpm build` went from **15
 * prerendered routes to 0** — `/`, `/login`, `/vod/jobs`, `/live`,
 * `/live/feeders`, `/qc`, `/qc/compare`, `/storage`, `/presets`, `/settings` and
 * its four children, plus `/_not-found`. Every one is now server-rendered on
 * demand.
 *
 * Accepted, for reasons in this order:
 *
 * 1. Those 15 were prerendered SHELLS. Each one immediately fetches its data
 *    client-side through TanStack Query, so the prerender saved a render, never a
 *    round trip.
 * 2. Every page request already passes through `proxy.ts`, which reads the
 *    session cookie and can 307 to `/login`. The per-request work was there
 *    before this change; what is new is rendering rather than serving a file.
 * 3. Every authenticated page uses the current organization and its access
 *    policy. Server rendering binds the initial browser scope to that request.
 *
 * The alternatives were worse, not merely harder. Resolving on the client keeps
 * the pages static but reintroduces the hydration mismatch and a flash of English
 * — and to avoid the mismatch it would have to fall back to English silently,
 * which is the exact failure the catalogue's typecheck exists to prevent. A
 * `/[locale]/…` segment would keep prerendering AND allow `generateStaticParams`,
 * but it moves every path out from under `proxy.ts`'s `config.matcher`, which is
 * what the auth gate is built on.
 *
 * If this ever needs reversing, the honest fix is a locale path segment plus a
 * matcher and `gate-coverage` update in the same commit — not a client-side read.
 */
export default async function RootLayout({
	children,
}: {
	children: ReactNode;
}) {
	// : the flags ride the SAME server pass that already made this
	// layout dynamic — one primary-key read, uncached (a flip takes effect on
	// the next request), degrading to defaults on any failure so /login still
	// renders before the database is reachable.
	const [cookieStore, headerStore, flags] = await Promise.all([
		cookies(),
		headers(),
		readFeatureFlags(),
	]);
	const locale = resolveLocale({
		cookie: cookieStore.get(LOCALE_COOKIE)?.value,
		acceptLanguage: headerStore.get("accept-language"),
	});
	const theme = resolveTheme(cookieStore.get(THEME_COOKIE)?.value);

	return (
		<html lang={locale} data-theme={theme}>
			<body className="min-h-screen bg-zinc-950 font-sans text-zinc-200 antialiased">
				<LocaleProvider locale={locale}>
					<FeatureFlagsProvider flags={flags}>
						<ThemeProvider initialTheme={theme}>
							<Providers
								organizationId={
									headerStore.get(ORGANIZATION_HEADER) ?? undefined
								}
							>
								<AppShell>{children}</AppShell>
							</Providers>
						</ThemeProvider>
					</FeatureFlagsProvider>
				</LocaleProvider>
			</body>
		</html>
	);
}

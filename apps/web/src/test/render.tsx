import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/context";

/**
 * The two render wrappers every component test needs.
 *
 * `useT` throws outside a provider rather than falling back to English — the
 * intended cost of having no silent fallback (lib/i18n/context.tsx) — so a component
 * test must declare a locale. That turned into the same 20-line wrapper pasted into
 * eleven files, plus eighteen copies of a shorter one and sixteen of a
 * query-client variant: forty-five copies of two ideas, each free to drift.
 *
 * Not in a `__tests__` directory and not named `*.test.tsx`, so vitest's
 * `src/**\/*.test.{ts,tsx}` include does not collect it as a suite.
 */

type Rendered = ReturnType<typeof rtlRender>;

/**
 * `rerender` replaces the whole tree, provider included, so re-wrapping it is not a
 * nicety: without it the second render throws where the first did not.
 */
function withRewrap(result: Rendered, wrap: (node: ReactNode) => ReactNode) {
	return {
		...result,
		rerender: (next: ReactNode) => result.rerender(wrap(next)),
	};
}

/** Render inside a `LocaleProvider`. Defaults to `en` so existing assertions hold. */
export function renderLocalized(node: ReactNode, locale: Locale = "en") {
	const wrap = (inner: ReactNode) => (
		<LocaleProvider locale={locale}>{inner}</LocaleProvider>
	);
	return withRewrap(rtlRender(wrap(node)), wrap);
}

/**
 * Render inside a `LocaleProvider` AND a fresh `QueryClientProvider`.
 *
 * Retries are off for queries and mutations. Every copy this replaced disabled query
 * retries; ten of them also disabled mutation retries, which is TanStack v5's default
 * anyway (`retry: 0`), so setting both is the union of what the copies did and cannot
 * turn a retry on. A test that wanted a retry would fail loudly here.
 *
 * The client is per-call, so no cache leaks between tests. It is NOT a copy of
 * production's client: `components/providers.tsx` also sets `staleTime: 15_000` and
 * `retry: 1`, so a test sees `staleTime: 0`. That matched all 45 copies, so it is not
 * a regression — but do not read this as parity with the app.
 */
export function renderWithQuery(node: ReactNode, locale: Locale = "en") {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const wrap = (inner: ReactNode) => (
		<LocaleProvider locale={locale}>
			<QueryClientProvider client={client}>{inner}</QueryClientProvider>
		</LocaleProvider>
	);
	// The client is part of the result so a test can observe cache effects
	// (e.g. that a mutation invalidated the right key) instead of stubbing
	// `window.location` — added for the capture-button invalidation .
	return { ...withRewrap(rtlRender(wrap(node)), wrap), client };
}

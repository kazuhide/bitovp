"use client";

/**
 * The only boundary that can catch a root-layout throw.
 *
 * There was none, anywhere, and that made a deliberate design choice worse than
 * it looked: `translate` and `useT` THROW rather than degrading, on the
 * argument that copy-shaped output survives review while a throw does not. True —
 * but `Sidebar`, `SessionMenu` and `LocaleSwitcher` render inside the root layout,
 * and a route-level `error.tsx` cannot catch errors thrown there. So a bad message
 * key produced a whole-app blank page reading "Application error: a client-side
 * exception has occurred", not a degraded sidebar (review catch).
 *
 * Keeping the throw and adding the boundary, rather than softening the throw: the
 * failure should be loud in development and legible in production, which is what
 * a boundary buys and a silent fallback does not.
 *
 * Deliberately NOT localized. It is the handler for "the i18n layer threw", so
 * reaching for the catalogue here is how a boundary turns into an infinite loop —
 * and it renders outside any `LocaleProvider`, where `useT` throws by design.
 * `<html lang="en">` for the same reason: global-error replaces the root layout
 * entirely, so it has to supply its own document shell.
 */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<html lang="en">
			<body className="min-h-screen bg-zinc-950 font-sans text-zinc-200 antialiased">
				<main className="flex min-h-screen items-center justify-center px-4 py-10">
					<div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
						<h1 className="font-semibold text-sm text-zinc-50">
							Something broke while rendering this page
						</h1>
						<p className="mt-3 text-sm text-zinc-400">
							The error is below. It came from the app shell rather than one
							screen, so retrying may not clear it — the server logs will have
							the stack.
						</p>
						{/*
						 * The message, not the stack. `error.message` from a client
						 * component is already sanitized by Next in production (it becomes
						 * a generic string plus a digest), and the digest is what correlates
						 * with the server log — so this leaks nothing the framework does not
						 * already choose to expose.
						 */}
						<pre className="mt-4 whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-amber-300">
							{error.message || "No message was attached to the error."}
						</pre>
						{error.digest ? (
							<p className="mt-2 text-xs text-zinc-600">
								Digest: <code>{error.digest}</code>
							</p>
						) : null}
						<div className="mt-5 flex gap-3">
							<button
								type="button"
								onClick={reset}
								className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700"
							>
								Try again
							</button>
							<a
								href="/"
								className="rounded-md px-3 py-1.5 text-emerald-400 text-sm hover:underline"
							>
								Back to the dashboard
							</a>
						</div>
					</div>
				</main>
			</body>
		</html>
	);
}

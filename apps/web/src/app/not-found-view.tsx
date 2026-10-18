"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/context";

/**
 * The 404 body. A client component because `useT` is a client hook, matching
 * `page.tsx` → `dashboard-home.tsx`.
 *
 * Until this existed, a bad URL rendered Next.js's own built-in "404 / This page
 * could not be found." — English, inside otherwise fully-Japanese chrome. No test
 * could see it: there was no component to render, so there was nothing to assert on,
 * and the i18n catalogue checks can only inspect strings that are IN the catalogue.
 * Found by reading `document.body.innerText` off the running app.
 */
export function NotFoundView() {
	const { t } = useT();
	return (
		<section className="mx-auto max-w-md py-16 text-center">
			<p className="font-mono text-6xl text-zinc-700">404</p>
			<h1 className="mt-4 font-semibold text-lg text-zinc-100">
				{t("notFound.title")}
			</h1>
			<p className="mt-2 text-sm text-zinc-400">{t("notFound.body")}</p>
			<Link
				href="/"
				className="mt-6 inline-block text-sm text-emerald-400 hover:text-emerald-300"
			>
				{t("notFound.backToDashboard")}
			</Link>
		</section>
	);
}

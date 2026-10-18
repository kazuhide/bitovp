"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/context";

export function SettingsBreadcrumb() {
	const { t } = useT();
	return (
		<nav
			aria-label={t("nav.settings")}
			className="mb-5 flex items-center gap-2 text-sm text-zinc-400"
		>
			<Link href="/settings" className="hover:text-zinc-100">
				{t("nav.settings")}
			</Link>
		</nav>
	);
}

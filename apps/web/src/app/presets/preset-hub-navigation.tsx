"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const links = [
	{ tab: "saved", href: "/presets", label: "templates.savedView" },
	{
		tab: "delivery",
		href: "/presets?tab=delivery",
		label: "templates.deliveryView",
	},
	{
		tab: "samples",
		href: "/presets?tab=samples",
		label: "templates.samplesView",
	},
] as const;

export function PresetHubNavigation({
	tab,
}: {
	tab: "saved" | "delivery" | "samples";
}) {
	const { t } = useT();
	return (
		<div className="space-y-4">
			<h1 className="font-semibold text-2xl text-zinc-100">
				{t("pageTitles.presets")}
			</h1>
			<nav
				aria-label={t("pageTitles.presets")}
				className="flex flex-wrap gap-2"
			>
				{links.map((link) => (
					<Link
						key={link.tab}
						href={link.href}
						aria-current={tab === link.tab ? "page" : undefined}
						className={cn(
							"inline-flex h-8 items-center rounded-md border px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2",
							tab === link.tab
								? "border-zinc-700 bg-zinc-800 text-zinc-100"
								: "border-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
						)}
					>
						{t(link.label)}
					</Link>
				))}
			</nav>
		</div>
	);
}

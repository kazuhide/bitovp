import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeProps = {
	children: ReactNode;
	/**
	 * `warn`  is amber — "we do not know", as distinct from ok's
	 * "it worked" and error's "it did not". It uses the same `amber-400` family
	 * `FlatSection` already paints its warn summaries in, so the two surfaces
	 * agree on what an unconfirmed thing looks like.
	 */
	tone?: "neutral" | "ok" | "warn" | "error";
	className?: string;
	/** Native tooltip — the truncated free-text label chip (118-A1) shows its full value here. */
	title?: string;
};

export function Badge({
	children,
	tone = "neutral",
	className,
	title,
}: BadgeProps) {
	return (
		<span
			title={title}
			className={cn(
				// whitespace-nowrap : a chip never wraps — CJK line-break
				// rules split the localized Incomplete badge inside the 420-pixel preview rail while
				// the English word could not, so only ja broke. 104 call sites are all
				// short chips by design (long prose rides OUTSIDE the badge — the
				// storage-picker hint pattern). 103 production sites (104 counted a
				// test — review-252 118-A2); the one FREE-TEXT child, job labels,
				// is bounded by truncate+title at its site (118-A1).
				"inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-[11px]",
				tone === "neutral" && "border-zinc-700 text-zinc-400",
				tone === "ok" &&
					"border-emerald-800 bg-emerald-950/40 text-emerald-300",
				tone === "warn" && "border-amber-800 bg-amber-950/40 text-amber-300",
				tone === "error" && "border-red-900 bg-red-950/40 text-red-300",
				className,
			)}
		>
			{children}
		</span>
	);
}

import type { ComponentProps } from "react";
import { demoHref } from "./navigation";

type Props = Omit<ComponentProps<"a">, "href"> & {
	href: string | { pathname?: string; query?: Record<string, string> };
	prefetch?: boolean;
	replace?: boolean;
	scroll?: boolean;
};

export default function Link({
	href,
	prefetch: _prefetch,
	replace: _replace,
	scroll: _scroll,
	...props
}: Props) {
	const path =
		typeof href === "string"
			? href
			: `${href.pathname ?? "/"}${href.query ? `?${new URLSearchParams(href.query)}` : ""}`;
	return <a {...props} href={demoHref(path)} />;
}

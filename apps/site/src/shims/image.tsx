import type { ComponentProps } from "react";

export default function Image({
	unoptimized: _unoptimized,
	priority: _priority,
	...props
}: ComponentProps<"img"> & { unoptimized?: boolean; priority?: boolean }) {
	return <img {...props} alt={props.alt ?? ""} />;
}

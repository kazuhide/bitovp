"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Thin styled wrappers over Radix Tabs (settings sub-surfaces). */

export function Tabs(props: ComponentProps<typeof TabsPrimitive.Root>) {
	return <TabsPrimitive.Root {...props} />;
}

export function TabsList({
	className,
	...props
}: ComponentProps<typeof TabsPrimitive.List>) {
	return (
		<TabsPrimitive.List
			className={cn(
				"inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsTrigger({
	className,
	...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
	return (
		<TabsPrimitive.Trigger
			className={cn(
				"rounded-md px-3 py-1.5 font-medium text-xs text-zinc-400 transition-colors hover:text-zinc-200",
				"focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2",
				"data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-50",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsContent({
	className,
	...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
	return (
		// The panel is tabbable (tabIndex=0) — keep a visible focus indicator
		// rather than stripping the browser default (same trio as Button).
		<TabsPrimitive.Content
			className={cn(
				"mt-6 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2",
				className,
			)}
			{...props}
		/>
	);
}

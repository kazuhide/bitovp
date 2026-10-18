"use client";

import type {
	InputHTMLAttributes,
	SelectHTMLAttributes,
	TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";
import { useFieldDescription } from "./field-description";

const fieldClasses =
	"w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-600 focus-visible:outline-none disabled:opacity-50";

export function Input({
	className,
	...props
}: InputHTMLAttributes<HTMLInputElement>) {
	const description = useFieldDescription(props.id, props["aria-describedby"]);
	return (
		<input
			className={cn(fieldClasses, "h-9", className)}
			{...props}
			aria-describedby={description}
		/>
	);
}

export function Textarea({
	className,
	...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	const description = useFieldDescription(props.id, props["aria-describedby"]);
	return (
		<textarea
			className={cn(fieldClasses, "min-h-24 font-mono text-xs", className)}
			{...props}
			aria-describedby={description}
		/>
	);
}

export function SelectNative({
	className,
	...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
	const description = useFieldDescription(props.id, props["aria-describedby"]);
	return (
		<select
			className={cn(fieldClasses, "h-9", className)}
			{...props}
			aria-describedby={description}
		/>
	);
}

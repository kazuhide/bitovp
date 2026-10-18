import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-emerald-600 text-white hover:bg-emerald-500",
				secondary:
					"border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800",
				ghost: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
				destructive:
					"border border-red-900/60 bg-red-950/40 text-red-300 hover:bg-red-900/40",
			},
			size: {
				default: "h-9 px-4",
				sm: "h-8 px-3 text-xs",
				icon: "h-8 w-8",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
	return (
		<button
			type="button"
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

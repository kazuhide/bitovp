"use client";
import { type BrandingSettings, DEFAULT_BRANDING_SETTINGS } from "@bitovp/core";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useBranding } from "./branding-provider";

export function BrandIcon({
	iconDataUrl,
}: Pick<BrandingSettings, "iconDataUrl">) {
	const [failed, setFailed] = useState<string | null>(null);
	return iconDataUrl && failed !== iconDataUrl ? (
		// A validated embedded raster is intentionally rendered without a remote
		// optimizer. The adjacent app name already supplies its accessible label.
		<Image
			unoptimized
			src={iconDataUrl}
			alt=""
			width={24}
			height={24}
			className="h-6 w-6 shrink-0 rounded object-contain"
			onError={() => setFailed(iconDataUrl)}
		/>
	) : (
		<span
			aria-hidden
			className="flex h-6 w-6 shrink-0 items-center justify-center text-emerald-400"
		>
			●
		</span>
	);
}
export function AppBrand() {
	const value = useBranding()?.value ?? DEFAULT_BRANDING_SETTINGS;
	return (
		<Link
			href="/"
			title={value.displayName}
			className="flex min-w-0 items-center gap-2 font-semibold text-sm text-zinc-50"
		>
			<BrandIcon iconDataUrl={value.iconDataUrl} />
			<span className="truncate">{value.displayName}</span>
		</Link>
	);
}

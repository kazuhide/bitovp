"use client";

import { BITMOVIN_CLOUD_REGIONS } from "@bitovp/core";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

/** SDK region names, retaining imported values until explicitly changed. */
export function RegionSelect({
	id,
	value = "",
	onChange,
	regions = BITMOVIN_CLOUD_REGIONS,
	emptyLabel,
	className,
}: {
	id: string;
	value?: string;
	onChange: (region: string) => void;
	regions?: readonly string[];
	emptyLabel?: string;
	className?: string;
}) {
	const { t } = useT();
	return (
		<SelectNative
			id={id}
			className={className}
			value={value}
			onChange={(event) => onChange(event.target.value)}
		>
			<option value="">{emptyLabel ?? t("wizard.default")}</option>
			{value && !regions.includes(value) && (
				<option value={value}>{value}</option>
			)}
			{regions.map((region) => (
				<option key={region} value={region}>
					{region}
				</option>
			))}
		</SelectNative>
	);
}

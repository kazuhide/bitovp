"use client";
import { useId } from "react";
import { Input, SelectNative, Textarea } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
export type EditorialValues = {
	title: string;
	description: string;
	tags: string;
	locale: string;
};
export function MetadataFields({
	value,
	onChange,
	locales,
}: {
	value: EditorialValues;
	onChange: (value: EditorialValues) => void;
	locales: string[];
}) {
	const { t } = useT();
	const id = useId();
	return (
		<div className="grid gap-3">
			<label htmlFor={`${id}-title`} className="space-y-1 text-sm">
				{t("library.contentTitle")}
				<Input
					id={`${id}-title`}
					required
					maxLength={500}
					value={value.title}
					onChange={(e) => onChange({ ...value, title: e.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-description`} className="space-y-1 text-sm">
				{t("library.description")}
				<Textarea
					id={`${id}-description`}
					maxLength={10000}
					value={value.description}
					onChange={(e) => onChange({ ...value, description: e.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-tags`} className="space-y-1 text-sm">
				{t("library.tags")}
				<Input
					value={value.tags}
					id={`${id}-tags`}
					onChange={(e) => onChange({ ...value, tags: e.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-locale`} className="space-y-1 text-sm">
				{t("library.locale")}
				<SelectNative
					id={`${id}-locale`}
					value={value.locale}
					onChange={(e) => onChange({ ...value, locale: e.target.value })}
				>
					{[...new Set([value.locale, ...locales])]
						.filter(Boolean)
						.map((locale) => (
							<option key={locale} value={locale}>
								{locale}
							</option>
						))}
				</SelectNative>
			</label>
		</div>
	);
}
export function editorialPayload(value: EditorialValues) {
	return {
		...value,
		tags: value.tags
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean),
	};
}

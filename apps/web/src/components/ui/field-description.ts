"use client";

import { createContext, useContext } from "react";

export const FieldDescription = createContext<{
	controlId: string;
	descriptionId?: string;
} | null>(null);

export function mergeDescription(existing: string | undefined, added?: string) {
	return added
		? [
				...new Set([...(existing?.split(/\s+/).filter(Boolean) ?? []), added]),
			].join(" ")
		: existing;
}

export function useFieldDescription(id?: string, existing?: string) {
	const field = useContext(FieldDescription);
	return mergeDescription(
		existing,
		id && id === field?.controlId ? field.descriptionId : undefined,
	);
}

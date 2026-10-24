import type { PerTitleAdviceField } from "./per-title-simulator-advice-fields";

export function focusPerTitleSetting(
	root: HTMLElement | null,
	field: PerTitleAdviceField,
): boolean {
	const marker = Array.from(
		root?.querySelectorAll<HTMLElement>("[data-setting-key]") ?? [],
	).find(
		(element) =>
			element.dataset.settingScope === field.scope &&
			element.dataset.settingKey === field.key &&
			(field.scope === "global" || element.dataset.settingRow === field.rowId),
	);
	if (!root || !marker?.dataset.settingControl) return false;
	const target = Array.from(
		marker.querySelectorAll<HTMLElement>("input,select,textarea"),
	).find((element) => element.id === marker.dataset.settingControl);
	if (!target || target.matches(":disabled")) return false;
	for (
		let parent = target.parentElement;
		parent && root.contains(parent);
		parent = parent.parentElement
	) {
		if (parent instanceof HTMLDetailsElement) parent.open = true;
	}
	target.scrollIntoView?.({ block: "center", behavior: "auto" });
	target.focus({ preventScroll: true });
	return target.ownerDocument.activeElement === target;
}

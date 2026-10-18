import { Label as LabelPrimitive } from "radix-ui";
import {
	Children,
	cloneElement,
	Fragment,
	isValidElement,
	type ReactNode,
	useId,
} from "react";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { FieldDescription, mergeDescription } from "./field-description";
import { HelpOverlay } from "./help-overlay";
import { InfoHint } from "./info-hint";

// Traverse only supplied native markup/Fragments, never evaluate opaque components.
// Composite controls participate through their shared Input's context instead.
function describeNative(
	children: ReactNode,
	controlId: string,
	descriptionId?: string,
): ReactNode {
	return Children.map(children, (child) => {
		if (
			!isValidElement<{
				id?: string;
				children?: ReactNode;
				"aria-describedby"?: string;
			}>(child) ||
			(typeof child.type !== "string" && child.type !== Fragment)
		)
			return child;
		if (
			controlId &&
			child.props.id === controlId &&
			["input", "select", "textarea"].includes(child.type as string)
		) {
			return cloneElement(child, {
				"aria-describedby": mergeDescription(
					child.props["aria-describedby"],
					descriptionId,
				),
			});
		}
		return child.props.children === undefined
			? child
			: cloneElement(child, {
					children: describeNative(
						child.props.children,
						controlId,
						descriptionId,
					),
				});
	});
}

export type FieldProps = {
	label: string;
	htmlFor: string;
	error?: string;
	hint?: string;
	/** Optional help text revealed by an ⓘ mark next to the label. */
	tooltip?: string;
	/** : click-to-open help panel (?) beside the label — the home
	 * for prose that used to render as an always-on hint. */
	help?: string;
	/**
	 * : a control that belongs ON the input row (e.g. a "browse
	 * storage" button). Rendered as a same-row sibling of the control, so
	 * the hint/error spans below BOTH — the previous pattern (an outer
	 * `flex items-end` around Field + Button) bottom-aligned the button
	 * with the HINT line whenever a hint or error rendered, which is the
	 * vertical drift the owner kept seeing.
	 */
	trailing?: ReactNode;
	children: ReactNode;
};

/** Label + control + hint/error row used by every settings form. */
export function Field({
	label,
	htmlFor,
	error,
	hint,
	tooltip,
	help,
	trailing,
	children,
}: FieldProps) {
	const { t } = useT();
	const id = useId();
	const descriptionId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
	const controls = (
		<FieldDescription.Provider value={{ controlId: htmlFor, descriptionId }}>
			{describeNative(children, htmlFor, descriptionId)}
		</FieldDescription.Provider>
	);
	const labelEl = (
		<LabelPrimitive.Root
			htmlFor={htmlFor}
			className="block font-medium text-xs text-zinc-300"
		>
			{label}
		</LabelPrimitive.Root>
	);
	return (
		<div className="space-y-1.5">
			{tooltip || help ? (
				<div className="flex items-center gap-1">
					{labelEl}
					{tooltip ? (
						<InfoHint
							text={tooltip}
							label={t("uiX.moreInformationFor", { label })}
						/>
					) : null}
					{help ? (
						<HelpOverlay label={t("uiX.moreInformationFor", { label })}>
							{help}
						</HelpOverlay>
					) : null}
				</div>
			) : (
				labelEl
			)}
			{trailing ? (
				<div className="flex items-center gap-2">
					<div className="min-w-0 flex-1">{controls}</div>
					<div className="shrink-0">{trailing}</div>
				</div>
			) : (
				controls
			)}
			{error ? (
				<p id={descriptionId} role="alert" className="text-red-400 text-xs">
					{error}
				</p>
			) : hint ? (
				<p id={descriptionId} className="text-xs text-zinc-500">
					{hint}
				</p>
			) : null}
		</div>
	);
}

/**
 * A horizontal row of `Field`s. Top-aligned, and that IS the feature.
 *
 * A Field is a label/control/hint stack whose height depends on STATE — a hint
 * appears, an error appears, a help mark wraps. Any cross-axis alignment other
 * than `start` therefore makes the row's boxes move relative to each other the
 * moment one of them grows, and bottom-alignment is the worst of them: the
 * tallest box pins the bottom edge, so every shorter box's label AND control
 * slide down together.
 *
 * That was not a theory. Measured in Chrome against the built app, before this
 * existed (owner report, 2026-08-20):
 *
 *   VOD step 3, choosing Per-Title  → a hint appears under Bitrate, and the
 *                                     Codec and Height labels drop 38px
 *   VOD step 4, add a delivery mirror → Provider and Bucket differ by 30px
 *
 *  met this once and fixed the one row it was reported on, adding
 * `Field`'s `trailing` prop for the button-on-the-input-line case. The pattern
 * survived at fifteen other rows, which is why the fix is now a component that
 * has to be USED rather than a rule that has to be remembered — and why
 * `field-row-alignment.test.ts` reads the tree instead of trusting this note.
 */
export function FieldRow({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-wrap items-start gap-2", className)}>
			{children}
		</div>
	);
}

/**
 * Puts a row-level control — the ✕ that removes the whole row, a submit button
 * that acts on the row — on the CONTROL line of a `FieldRow`, where
 * `items-start` alone would leave it up on the label line.
 *
 * The spacer is an INVISIBLE COPY OF A LABEL, not a hardcoded offset: same
 * `block font-medium text-xs`, same `space-y-1.5` rhythm as `Field` itself. So
 * it tracks the label's font size and the locale's line-height rather than
 * drifting away from them the first time either changes. `&nbsp;` rather than
 * an empty span because an empty inline box generates no line.
 *
 * Not for a control that belongs to ONE field — that is `Field`'s `trailing`,
 * which keeps the hint and error spanning both.
 */
export function FieldRowAction({ children }: { children: ReactNode }) {
	return (
		<div className="space-y-1.5">
			<span aria-hidden="true" className="invisible block font-medium text-xs">
				&nbsp;
			</span>
			{children}
		</div>
	);
}

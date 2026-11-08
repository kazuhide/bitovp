import { type CompositionDocument, canonicalEditingJson } from "@bitovp/core";
import { useCallback, useEffect, useRef, useState } from "react";

type Options<T> = {
	document: CompositionDocument;
	contextKey: string;
	disabled: boolean;
	apply: (document: CompositionDocument, value: T) => CompositionDocument;
	onCommit: (document: CompositionDocument) => void;
	onPending: (pending: boolean) => void;
	onInvalid?: () => void;
};

export function useDirectCropGesture<T>(options: Options<T>) {
	const latest = useRef(options);
	latest.current = options;
	const gesture = useRef<{
		document: CompositionDocument;
		contextKey: string;
		json: string;
	} | null>(null);
	const [preview, setPreview] = useState<CompositionDocument | null>(null);
	const cancel = useCallback(() => {
		if (!gesture.current) return;
		gesture.current = null;
		setPreview(null);
		latest.current.onPending(false);
	}, []);
	const current = () => {
		const held = gesture.current;
		return held &&
			!latest.current.disabled &&
			held.document === latest.current.document &&
			held.contextKey === latest.current.contextKey
			? held
			: null;
	};
	useEffect(() => {
		const held = gesture.current;
		if (
			held &&
			(options.disabled ||
				held.document !== options.document ||
				held.contextKey !== options.contextKey)
		)
			cancel();
	}, [options.disabled, options.document, options.contextKey, cancel]);
	useEffect(
		() => () => {
			if (gesture.current) {
				gesture.current = null;
				latest.current.onPending(false);
			}
		},
		[],
	);
	const apply = (value: T, commit: boolean) => {
		const held = current();
		if (!held) return cancel();
		try {
			const next = latest.current.apply(held.document, value);
			if (!commit) return setPreview(next);
			cancel();
			if (canonicalEditingJson(next) !== held.json)
				latest.current.onCommit(next);
		} catch {
			cancel();
			latest.current.onInvalid?.();
		}
	};
	return {
		document: preview ?? options.document,
		active: preview !== null,
		begin: () => {
			if (latest.current.disabled || gesture.current) return false;
			gesture.current = {
				document: latest.current.document,
				contextKey: latest.current.contextKey,
				json: canonicalEditingJson(latest.current.document),
			};
			setPreview(latest.current.document);
			latest.current.onPending(true);
			return true;
		},
		preview: (value: T) => apply(value, false),
		commit: (value: T) => apply(value, true),
		cancel,
	};
}

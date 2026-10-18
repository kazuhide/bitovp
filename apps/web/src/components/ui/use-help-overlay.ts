"use client";

import {
	type FocusEvent,
	type MouseEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

type ElementRef = RefObject<HTMLElement | null>;

export const helpContentProps = {
	sideOffset: 4,
	collisionPadding: 8,
	sticky: "always",
	updatePositionStrategy: "always",
	style: {
		maxWidth:
			"min(calc(100vw - 16px), var(--radix-popover-content-available-width))",
		maxHeight: "var(--radix-popover-content-available-height)",
		overflowY: "auto",
		overflowWrap: "anywhere",
	},
} as const;

export function useHelpInteraction(
	root: ElementRef,
	trigger: ElementRef,
	panel: ElementRef,
) {
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const pendingFocus = useRef(false);
	const shown = !dismissed && (hovered || focused || pinned);
	const clearLeave = useCallback(() => clearTimeout(leaveTimer.current), []);
	const close = useCallback(
		(restoreFocus = false) => {
			clearLeave();
			pendingFocus.current = restoreFocus;
			if (restoreFocus && !trigger.current?.closest('[role="dialog"]'))
				trigger.current?.focus({ preventScroll: true });
			setPinned(false);
			setHovered(false);
			setFocused(false);
			setDismissed(true);
		},
		[clearLeave, trigger],
	);
	const onMouseEnter = () => {
		clearLeave();
		setHovered(true);
		setDismissed(false);
	};
	const onMouseLeave = () => {
		clearLeave();
		leaveTimer.current = setTimeout(() => setHovered(false), 120);
	};
	const onFocus = () => {
		setFocused(true);
		setDismissed(false);
	};
	const onBlur = (event: FocusEvent<HTMLElement>) => {
		const next = event.relatedTarget as Node | null;
		if (!root.current?.contains(next) && !panel.current?.contains(next))
			setFocused(false);
	};
	const onClick = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
		if (pinned) close();
		else {
			clearLeave();
			setDismissed(false);
			setPinned(true);
		}
	};
	useEffect(() => clearLeave, [clearLeave]);
	useEffect(() => {
		if (pinned) panel.current?.focus({ preventScroll: true });
	}, [pinned, panel]);
	return {
		shown,
		pinned,
		close,
		onClick,
		onOpenChange: (open: boolean) => {
			if (!open) close();
		},
		onOpenAutoFocus: (event: Event) => {
			event.preventDefault();
			if (pinned) panel.current?.focus({ preventScroll: true });
		},
		onCloseAutoFocus: (event: Event) => {
			event.preventDefault();
			if (pendingFocus.current) {
				trigger.current?.focus({ preventScroll: true });
				setDismissed(true);
				pendingFocus.current = false;
			}
		},
		onPointerDownOutside: (event: {
			target: EventTarget | null;
			preventDefault(): void;
		}) => {
			if (trigger.current?.contains(event.target as Node))
				event.preventDefault();
		},
		onEscapeKeyDown: (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			close(pinned);
		},
		previewEvents: { onMouseEnter, onMouseLeave, onFocus, onBlur },
	};
}

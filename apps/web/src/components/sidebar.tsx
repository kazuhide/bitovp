"use client";

import { PanelLeftOpen } from "lucide-react";
import { type PointerEvent, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { AppBrand } from "./app-brand";
import { NavList } from "./nav-list";
import { SessionMenu } from "./session-menu";

const SIDEBAR_WIDTH = 240;

/** Desktop only. Its width changes without remounting the page or its players. */
export function Sidebar() {
	const { t } = useT();
	const navigationId = useId();
	const [width, setWidth] = useState(SIDEBAR_WIDTH);
	const separatorRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{
		pointerId: number;
		startX: number;
		startWidth: number;
		target: HTMLDivElement;
	} | null>(null);
	const collapsed = width === 0;

	function dragWidth(clientX: number) {
		const current = drag.current;
		return current
			? Math.max(
					0,
					Math.min(
						SIDEBAR_WIDTH,
						current.startWidth + clientX - current.startX,
					),
				)
			: width;
	}

	function finishDrag(nextWidth: number) {
		const current = drag.current;
		drag.current = null;
		setWidth(nextWidth);
		if (current?.target.hasPointerCapture(current.pointerId)) {
			current.target.releasePointerCapture(current.pointerId);
		}
	}

	function cancelDrag(event?: PointerEvent<HTMLDivElement>) {
		if (
			drag.current &&
			(!event || event.pointerId === drag.current.pointerId)
		) {
			finishDrag(drag.current.startWidth);
		}
	}

	return (
		<aside
			className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-zinc-800 border-r bg-zinc-900/40 md:flex"
			style={{ width, borderRightWidth: collapsed ? 0 : undefined }}
		>
			<div
				id={navigationId}
				className="h-full overflow-hidden"
				inert={collapsed}
				aria-hidden={collapsed || undefined}
			>
				<div className="flex h-full w-60 flex-col">
					<div className="border-zinc-800 border-b px-5 py-4">
						<AppBrand />
						<p className="mt-1 text-xs text-zinc-500">{t("nav.tagline")}</p>
					</div>
					<NavList />
					<div className="space-y-2 border-zinc-800 border-t px-5 py-3">
						<SessionMenu />
					</div>
				</div>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: This focusable pane splitter handles resizing; an hr is a static rule. */}
			<div
				ref={separatorRef}
				role="separator"
				tabIndex={0}
				aria-label={t("shell.resizeNavigation")}
				aria-orientation="vertical"
				aria-controls={navigationId}
				aria-valuemin={0}
				aria-valuemax={SIDEBAR_WIDTH}
				aria-valuenow={width}
				title={t("shell.resizeNavigationHint")}
				className="group absolute inset-y-0 -right-1.5 z-30 flex w-3 touch-none cursor-col-resize items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
				onPointerDown={(event) => {
					if (event.button !== 0 || !event.isPrimary || drag.current) return;
					event.preventDefault();
					event.currentTarget.focus();
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = {
						pointerId: event.pointerId,
						startX: event.clientX,
						startWidth: width,
						target: event.currentTarget,
					};
				}}
				onPointerMove={(event) => {
					if (event.pointerId === drag.current?.pointerId) {
						setWidth(dragWidth(event.clientX));
					}
				}}
				onPointerUp={(event) => {
					if (event.pointerId === drag.current?.pointerId) {
						finishDrag(
							dragWidth(event.clientX) < SIDEBAR_WIDTH / 2 ? 0 : SIDEBAR_WIDTH,
						);
					}
				}}
				onPointerCancel={cancelDrag}
				onLostPointerCapture={cancelDrag}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						cancelDrag();
						return;
					}
					if (
						["ArrowLeft", "Home", "ArrowRight", "End", "Enter"].includes(
							event.key,
						)
					) {
						event.preventDefault();
						const hide =
							event.key === "ArrowLeft" ||
							event.key === "Home" ||
							(event.key === "Enter" && !collapsed);
						finishDrag(hide ? 0 : SIDEBAR_WIDTH);
					}
				}}
			>
				<span
					aria-hidden="true"
					className="h-8 w-0.5 rounded bg-zinc-600 group-hover:bg-blue-500 group-focus-visible:bg-blue-500"
				/>
			</div>
			{collapsed && (
				<button
					type="button"
					aria-label={t("shell.showNavigation")}
					title={t("shell.showNavigation")}
					className="absolute top-3 left-1 z-30 flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500"
					onClick={() => {
						finishDrag(SIDEBAR_WIDTH);
						separatorRef.current?.focus();
					}}
				>
					<PanelLeftOpen aria-hidden="true" className="h-4 w-4" />
				</button>
			)}
		</aside>
	);
}

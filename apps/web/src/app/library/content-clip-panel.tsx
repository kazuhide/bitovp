"use client";

import { Film } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/context";
import { ClipProjects } from "./clip-projects";

/** Clip browsing is an auxiliary overlay; the original player stays mounted. */
export function ContentClipPanel({
	contentId,
	clipEditingAvailable = false,
}: {
	contentId: string;
	clipEditingAvailable?: boolean;
}) {
	return clipEditingAvailable ? (
		<AvailableContentClipPanel contentId={contentId} />
	) : null;
}

function AvailableContentClipPanel({ contentId }: { contentId: string }) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const triggerId = useId();
	useEffect(() => {
		const restore = () => setOpen(window.location.hash === "#clip-drafts");
		restore();
		window.addEventListener("hashchange", restore);
		window.addEventListener("popstate", restore);
		return () => {
			window.removeEventListener("hashchange", restore);
			window.removeEventListener("popstate", restore);
		};
	}, []);
	const change = (value: boolean) => {
		setOpen(value);
		if (value || window.location.hash === "#clip-drafts") {
			const url = new URL(window.location.href);
			url.hash = value ? "clip-drafts" : "";
			window.history.replaceState(window.history.state, "", url);
		}
		if (!value)
			requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
	};
	return (
		<>
			<Button
				id={triggerId}
				variant="secondary"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => change(true)}
			>
				<Film className="size-4" aria-hidden="true" />
				{t("editing.clips")}
			</Button>
			<Dialog
				open={open}
				onOpenChange={change}
				title={t("editing.clipDrafts")}
				wide
			>
				{open && (
					<ClipProjects
						contentId={contentId}
						showHeading={false}
						clipEditingAvailable
					/>
				)}
			</Dialog>
		</>
	);
}

"use client";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { LiveDvbRow, LiveWizardState } from "./build-live-plan";

export function LiveDvbSubtitlesSection({
	state,
	onPatch,
}: {
	state: LiveWizardState;
	onPatch: (patch: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	const id = useId();
	const rows = state.dvbSubtitles ?? [];
	const transport =
		state.inputKind === "SRT" ||
		state.inputKind === "ZIXI" ||
		state.inputKind === "HLS";
	if (!transport && !rows.length) return null;
	function update(index: number, change: Partial<LiveDvbRow>) {
		onPatch({
			dvbSubtitles: rows.map((r, n) => (n === index ? { ...r, ...change } : r)),
		});
	}
	function append() {
		let number = 1;
		while (rows.some((r) => r.key === `dvb-${number}`)) number++;
		const positions = new Set([
			...state.audios.map((a) => a.input?.position ?? 1),
			...state.videos.map((v) => v.input?.position ?? 0),
			...rows.map((r) => r.position),
		]);
		let position = 2;
		while (positions.has(position)) position++;
		onPatch({
			dvbSubtitles: [
				...rows,
				{
					key: `dvb-${number}`,
					position,
					language: "",
					label: "",
					packaging: "CHUNKED_TEXT",
				},
			],
		});
	}
	return (
		<section aria-labelledby={id} className="mt-6 space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 id={id} className="font-medium text-sm">
					{t("liveDvb.title")}
				</h3>
				<Button
					size="sm"
					variant="secondary"
					type="button"
					onClick={append}
					disabled={!transport || rows.length >= 64}
				>
					{t("liveDvb.add")}
				</Button>
			</div>
			{rows.length > 0 && (
				<p className="text-sm text-zinc-400">
					{t(transport ? "liveDvb.help" : "liveDvb.transport")}
				</p>
			)}
			{rows.map((row, index) => {
				const prefix = `${id}-${row.key}`;
				return (
					<fieldset
						key={row.key}
						aria-label={row.label || t("liveDvb.title")}
						className="grid gap-3 rounded border border-zinc-800 p-3 sm:grid-cols-2"
					>
						<Field htmlFor={`${prefix}-position`} label={t("liveDvb.position")}>
							<Input
								id={`${prefix}-position`}
								type="number"
								min={0}
								max={2147483647}
								value={row.position ?? ""}
								onChange={(e) =>
									update(index, {
										position:
											e.target.value === ""
												? undefined
												: Number(e.target.value),
									})
								}
							/>
						</Field>
						<Field htmlFor={`${prefix}-language`} label={t("liveDvb.language")}>
							<Input
								id={`${prefix}-language`}
								value={row.language}
								placeholder="ja"
								onChange={(e) => update(index, { language: e.target.value })}
							/>
						</Field>
						<Field htmlFor={`${prefix}-label`} label={t("liveDvb.label")}>
							<Input
								id={`${prefix}-label`}
								value={row.label}
								onChange={(e) => update(index, { label: e.target.value })}
							/>
						</Field>
						<Field
							htmlFor={`${prefix}-packaging`}
							label={t("liveDvb.packaging")}
						>
							<SelectNative
								id={`${prefix}-packaging`}
								value={row.packaging}
								onChange={(e) =>
									update(index, {
										packaging:
											e.target.value === "FMP4" ? "FMP4" : "CHUNKED_TEXT",
									})
								}
							>
								<option value="CHUNKED_TEXT">{t("liveDvb.chunked")}</option>
								<option value="FMP4">{t("liveDvb.fmp4")}</option>
							</SelectNative>
						</Field>
						<Button
							className="justify-self-start"
							variant="ghost"
							size="sm"
							type="button"
							onClick={() =>
								onPatch({
									dvbSubtitles:
										rows.length === 1
											? undefined
											: rows.filter((_, n) => n !== index),
								})
							}
						>
							{t("liveDvb.remove")}
						</Button>
					</fieldset>
				);
			})}
		</section>
	);
}

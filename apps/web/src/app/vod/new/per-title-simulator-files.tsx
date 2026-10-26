"use client";

import type { PerTitleCodec, PerTitleGoal } from "@bitovp/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import { perTitleSimulatorCopy } from "./per-title-simulator-copy";
import {
	type PerTitleReference,
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "./per-title-simulator-preset";

export function PerTitleSimulatorFiles({
	goal,
	reference,
	allowedCodecs,
	onLoad,
}: {
	goal: PerTitleGoal;
	reference?: PerTitleReference;
	allowedCodecs: readonly PerTitleCodec[];
	onLoad: (goal: PerTitleGoal, reference?: PerTitleReference) => void;
}) {
	const { locale } = useT();
	const copy = perTitleSimulatorCopy[locale];
	const input = useRef<HTMLInputElement>(null);
	const reader = useRef<FileReader | null>(null);
	const pendingGoal = useRef<PerTitleGoal | undefined>(undefined);
	const context = useRef(goal);
	context.current = goal;
	const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
		"idle",
	);
	useEffect(
		() => () => {
			reader.current?.abort();
			reader.current = null;
		},
		[],
	);
	useEffect(() => {
		if (
			reader.current?.readyState === FileReader.LOADING &&
			pendingGoal.current !== goal
		) {
			reader.current.abort();
			reader.current = null;
			setStatus("idle");
		}
	}, [goal]);
	function load(file: File) {
		const previous = reader.current;
		reader.current = null;
		previous?.abort();
		if (file.size > 128 * 1024) {
			setStatus("error");
			return;
		}
		const pending = new FileReader();
		const capturedGoal = goal;
		pendingGoal.current = capturedGoal;
		reader.current = pending;
		setStatus("loading");
		pending.onload = () => {
			if (reader.current !== pending || context.current !== capturedGoal)
				return;
			try {
				const preset = parsePerTitlePreset(
					String(pending.result),
					allowedCodecs,
				);
				onLoad(preset.goal, preset.reference);
				setStatus("loaded");
			} catch {
				setStatus("error");
			}
		};
		pending.onerror = () => {
			if (reader.current === pending && context.current === capturedGoal)
				setStatus("error");
		};
		pending.readAsText(file);
	}
	function save() {
		try {
			const contents = serializePerTitlePreset(goal, reference);
			const url = URL.createObjectURL(
				new Blob([contents], { type: "application/json" }),
			);
			const link = document.createElement("a");
			link.href = url;
			link.download = "per-title-requirements.json";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch {
			setStatus("error");
		}
	}
	const fileControls = (
		<>
			<div className="flex flex-wrap gap-2">
				<Button
					variant="secondary"
					size="sm"
					onClick={() => input.current?.click()}
					disabled={status === "loading"}
				>
					{copy.loadRequirements}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={save}
					disabled={status === "loading"}
				>
					{copy.saveRequirements}
				</Button>
				<input
					ref={input}
					type="file"
					accept=".json,application/json"
					aria-label={copy.loadRequirements}
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) load(file);
					}}
				/>
			</div>
			<p className="text-xs text-zinc-400">{copy.fileHint}</p>
		</>
	);
	return (
		<details className="space-y-3 border-b border-zinc-800 pb-4 text-xs text-zinc-400">
			<summary className="cursor-pointer">{copy.requirementFiles}</summary>
			{fileControls}
			{status !== "idle" ? (
				<p
					role={status === "error" ? "alert" : "status"}
					className={`text-xs ${status === "error" ? "text-red-300" : "text-zinc-400"}`}
				>
					{status === "error"
						? copy.fileError
						: status === "loading"
							? copy.fileLoading
							: copy.fileLoaded}
				</p>
			) : null}
		</details>
	);
}

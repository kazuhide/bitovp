"use client";

import type { SamplePreset, SamplePresetFamily } from "@bitovp/core/presets";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import {
	presetDescriptionKey,
	presetFamilyKey,
	presetTitleKey,
} from "@/lib/preset-copy";
import { PresetOpsPeek } from "./preset-ops-peek";

/**
 * C4's placeholder tokens, self-quoted — the catalogue value SPELLS the braces
 * (`{height}/{bitrate}/{uuid}`) and the interpolator is fed the literals, the
 * same idiom `preset-checklist.tsx` already uses for the same three tokens.
 * Passing them to every description is harmless: `t` only requires what a
 * value declares, and only one declares these.
 */
const C4_TOKENS = {
	height: "{height}",
	bitrate: "{bitrate}",
	uuid: "{uuid}",
};

/**
 * The 56 encoding examples scenarios as one-click presets — every golden plan
 * fixture, grouped by sample family. "Load in wizard" opens /vod/new and, when
 * the wizard form can rebuild the plan exactly, prefills the step-by-step form
 * so the user edits it the familiar way. Plans beyond the form's surface (DRM,
 * Dolby, per-title, AI Scene Analysis, …) fall back to the verbatim
 * imported-plan path with a checklist for the placeholder credentials/paths.
 */
export function PresetGallery({
	families,
	presets,
}: {
	families: { id: SamplePresetFamily }[];
	presets: SamplePreset[];
}) {
	const { t } = useT();
	const canOperate = useMutationAccess("presets.samples");
	const [query, setQuery] = useState("");
	const searchId = useId();

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle === "") {
			return presets;
		}
		// The TRANSLATED copy, so a Japanese operator can search in Japanese —
		// core carries ids only  and the name stays searchable as-is.
		return presets.filter((preset) =>
			[
				preset.name,
				t(presetTitleKey(preset.name)),
				t(presetDescriptionKey(preset.name), C4_TOKENS),
				preset.family,
				// The TRANSLATED family label too: a heading the operator can SEE
				// must be findable — the raw id alone gave Japanese headings zero
				// hits (「Dolby Vision & Atmos」 spans 18 presets; review finding).
				t(presetFamilyKey(preset.family)),
			].some((text) => text.toLowerCase().includes(needle)),
		);
	}, [presets, query, t]);

	return (
		<section className="space-y-6">
			<header className="space-y-2">
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-2">
						<h2 className="font-semibold text-xl text-zinc-50">
							{t("ui.samplePresets")}
						</h2>
						<HelpOverlay labelFor={t("ui.samplePresets")}>
							{t("prose.presetGalleryIntro")}
						</HelpOverlay>
					</div>
					<Badge tone="ok">
						{t("uiX.scenariosCount", { count: presets.length })}
					</Badge>
				</div>

				<div className="max-w-sm">
					<label htmlFor={searchId} className="sr-only">
						{t("ui.searchPresets")}
					</label>
					<Input
						id={searchId}
						type="search"
						placeholder={t("ui.searchTitleDescriptionFamily")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
			</header>

			{filtered.length === 0 ? (
				<p className="text-sm text-zinc-500">
					{t("uiX.noPresetsMatch", { query: query.trim() })}
				</p>
			) : (
				families.map((family) => {
					const members = filtered.filter(
						(preset) => preset.family === family.id,
					);
					if (members.length === 0) {
						return null;
					}
					return (
						<section key={family.id} aria-label={t(presetFamilyKey(family.id))}>
							<div className="flex items-baseline gap-2">
								<h2 className="font-medium text-sm text-zinc-200">
									{t(presetFamilyKey(family.id))}
								</h2>
								<span className="text-xs text-zinc-500">
									{t(
										members.length === 1
											? "uiX.presetCountOne"
											: "uiX.presetCountOther",
										{ count: members.length },
									)}
								</span>
							</div>
							<ul className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
								{members.map((preset) => (
									<li
										key={preset.name}
										className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
									>
										<div className="flex items-start justify-between gap-2">
											<h3 className="min-w-0 break-words font-medium text-sm text-zinc-100">
												{t(presetTitleKey(preset.name))}
											</h3>
											{/*  item 13: the count opens the compiled list. */}
											<PresetOpsPeek
												name={preset.name}
												opCount={preset.opCount}
											/>
										</div>
										<p className="text-xs text-zinc-400">
											{t(presetDescriptionKey(preset.name), C4_TOKENS)}
										</p>
										<div className="mt-auto flex items-center justify-between gap-2 pt-1">
											<code className="truncate font-mono text-[11px] text-zinc-600">
												{preset.name}
											</code>
											{canOperate ? (
												<Link
													href={`/vod/new?preset=${encodeURIComponent(preset.name)}`}
													className="inline-flex h-8 shrink-0 items-center rounded-md bg-emerald-600 px-3 font-medium text-white text-xs transition-colors hover:bg-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
												>
													{t("ui.loadInWizard")}
												</Link>
											) : null}
										</div>
									</li>
								))}
							</ul>
						</section>
					);
				})
			)}
		</section>
	);
}

"use client";

import { encodingPlanSchema, withheldPlanSources } from "@bitovp/core";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

type WithheldSources = NonNullable<ReturnType<typeof withheldPlanSources>>;

/** Replacements belong only to the version of the source the operator opened. */
export function useWithheldSourceInputs(
	raw: unknown,
	version: string | undefined,
) {
	const sources = useMemo(() => withheldPlanSources(raw), [raw]);
	const [resolved, setResolved] = useState<{
		original: unknown;
		version: string | undefined;
		body: Record<string, unknown>;
	} | null>(null);
	const matching =
		resolved && resolved.version === version && resolved.original === raw
			? resolved
			: null;
	useEffect(() => {
		if (resolved && !matching) setResolved(null);
	}, [resolved, matching]);
	const malformed =
		!sources &&
		raw !== null &&
		typeof raw === "object" &&
		"withheldSourcePaths" in raw;
	const body =
		matching?.body ??
		(!sources &&
		!malformed &&
		raw &&
		typeof raw === "object" &&
		!Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: undefined);
	return {
		body,
		malformed,
		pending: matching ? null : sources,
		resolvedPaths: matching
			? sources?.resolvedInputPaths(matching.body)
			: undefined,
		resolve: (body: Record<string, unknown>) =>
			setResolved({ original: raw, version, body }),
		clear: () => setResolved(null),
	};
}

export function WithheldSourceInputs({
	sources,
	onResolve,
}: {
	sources: WithheldSources;
	onResolve: (body: Record<string, unknown>) => void;
}) {
	const { t } = useT();
	const id = useId();
	const [invalid, setInvalid] = useState(false);
	const [paths, setPaths] = useState<string[]>(() =>
		sources.labels.map(() => ""),
	);
	return (
		<section className="space-y-3">
			<p className="text-sm text-zinc-300">
				{t("templates.protectedInputHint")}
			</p>
			{sources.labels.map((label, index) => (
				<Field key={`${id}-${index}`} htmlFor={`${id}-${index}`} label={label}>
					<Input
						id={`${id}-${index}`}
						value={paths[index] ?? ""}
						autoComplete="off"
						required
						onChange={(event) =>
							setPaths(
								paths.map((old, n) => (n === index ? event.target.value : old)),
							)
						}
					/>
				</Field>
			))}
			{invalid && (
				<p role="alert" className="text-rose-400 text-sm">
					{t("templates.notAPlan")}
				</p>
			)}
			<Button
				type="button"
				disabled={paths.some((path) => !path.trim())}
				onClick={() => {
					const body = sources.fill(paths);
					if (body && encodingPlanSchema.safeParse(body).success)
						onResolve(body);
					else setInvalid(true);
				}}
			>
				{t("templates.useReplacementInputs")}
			</Button>
		</section>
	);
}

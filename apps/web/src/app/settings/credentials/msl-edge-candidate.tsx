"use client";

import { mslPlaybackEventPath } from "@bitovp/core";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldRow, FieldRowAction } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

/** The three MSL stream formats, each with its own event-root prefix. */
const FORMATS = ["HLS", "DASH", "CMAF"] as const;
type Format = (typeof FORMATS)[number];

/** Same rail as the GENERIC_S3 host: a bare hostname, never a URL. */
const BARE_HOSTNAME =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The MSL4 delivery root, or null when any part is missing or malformed.
 *
 * Exported for the test: the rule is `https://<host>` + Akamai's documented
 * event path for the format (`mslPlaybackEventPath`, the same helper the
 * verifier binds edge evidence with) minus the trailing slash the credential
 * schema refuses. The host is never guessed — it comes from the operator.
 */
export function mslEdgeBaseUrlCandidate(args: {
	host: string;
	format: Format;
	streamId: unknown;
	eventName: unknown;
}): string | null {
	const host = args.host.trim();
	const streamId = Number(args.streamId);
	const eventName = typeof args.eventName === "string" ? args.eventName : "";
	if (
		host === "" ||
		!BARE_HOSTNAME.test(host) ||
		!Number.isInteger(streamId) ||
		streamId <= 0 ||
		eventName === ""
	) {
		return null;
	}
	const path = mslPlaybackEventPath(args.format, streamId, eventName);
	return `https://${host.toLowerCase()}${path.replace(/\/$/, "")}`;
}

type MslEdgeCandidateProps = {
	/** Live values of the two identity fields above this block. */
	streamId: unknown;
	eventName: unknown;
	/** Writes the candidate into the credential's `edgeBaseUrl` input. */
	onFill: (url: string) => void;
};

/* Build an MSL4 candidate from the host entered by the operator and the stream ID and event name already in the form. The app cannot discover the playback property hostname. No host or format is guessed. MSL5 operators paste the Control Center value. Candidate scaffolding is local state; the editable credential field remains authoritative. */
export function MslEdgeCandidate({
	streamId,
	eventName,
	onFill,
}: MslEdgeCandidateProps) {
	const { t } = useT();
	const id = useId();
	const [host, setHost] = useState("");
	const [format, setFormat] = useState<Format>("HLS");
	const candidate = mslEdgeBaseUrlCandidate({
		host,
		format,
		streamId,
		eventName,
	});
	const hostError =
		host.trim() !== "" && !BARE_HOSTNAME.test(host.trim())
			? t("zerr.hostBareHostname")
			: undefined;
	return (
		<fieldset className="space-y-3 rounded-md border border-zinc-800 p-3">
			<legend className="flex items-center gap-1 px-1 text-xs text-zinc-500">
				{t("settings.mslEdgeCandidateLegend")}
				<HelpOverlay labelFor={t("settings.mslEdgeCandidateLegend")}>
					{t("settings.mslEdgeCandidateExplain")}
				</HelpOverlay>
			</legend>
			<FieldRow>
				<div className="min-w-56 flex-1">
					<Field
						label={t("settings.mslEdgeCandidateHost")}
						htmlFor={`${id}-host`}
						error={hostError}
					>
						<Input
							id={`${id}-host`}
							value={host}
							placeholder="example.akamaized.net"
							autoComplete="off"
							spellCheck={false}
							aria-invalid={hostError ? true : undefined}
							onChange={(e) => setHost(e.target.value)}
						/>
					</Field>
				</div>
				<div className="w-32">
					<Field
						label={t("settings.mslEdgeCandidateFormat")}
						htmlFor={`${id}-format`}
					>
						<SelectNative
							id={`${id}-format`}
							value={format}
							onChange={(e) => setFormat(e.target.value as Format)}
						>
							{FORMATS.map((option) => (
								<option key={option} value={option}>
									{option}
								</option>
							))}
						</SelectNative>
					</Field>
				</div>
				<FieldRowAction>
					<Button
						type="button"
						variant="secondary"
						disabled={candidate === null}
						onClick={() => {
							if (candidate !== null) {
								onFill(candidate);
							}
						}}
					>
						{t("settings.mslEdgeCandidateFill")}
					</Button>
				</FieldRowAction>
			</FieldRow>
			{candidate !== null ? (
				<p className="break-all text-xs text-zinc-500">
					{t("settings.mslEdgeCandidatePreview")} <code>{candidate}</code>
				</p>
			) : null}
		</fieldset>
	);
}

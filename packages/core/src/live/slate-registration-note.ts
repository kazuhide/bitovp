import {
	hasPrivateStorageLocator,
	publicStorageDiagnostic,
} from "../plan/hdr-source-paths";
import { slateSourceSchema } from "./program-schedule";
import { slateNormalizedKey } from "./slate-normalize";

type RetainedSlateNote = {
	note?: string | null;
	action?: string;
	insertableContentId?: string | null;
	slateSource?: unknown;
};

/** Preserve the selected object's name in a confirmed local conversion receipt.
 * Every other part of the note remains opaque diagnostic text. */
export function publicSlateRegistrationNote(row: RetainedSlateNote) {
	const note = row.note;
	const projected = publicStorageDiagnostic(note);
	if (
		!note ||
		projected === note ||
		row.action !== "SLATE_IN" ||
		!row.insertableContentId
	)
		return projected;
	const prefix = `slate content registered (${row.insertableContentId}); `;
	if (!note.startsWith(prefix)) return projected;
	const source = slateSourceSchema.safeParse(row.slateSource);
	if (!source.success || hasPrivateStorageLocator(source.data.key))
		return projected;

	const separator = " → ";
	const separatorAt = note.indexOf(separator, prefix.length);
	if (separatorAt < 0) return projected;
	const media = note.slice(prefix.length, separatorAt);
	const destination = note.slice(separatorAt + separator.length);
	const target =
		/^converted to MPEG-TS (\d+)x(\d+) (\d+(?:\.\d+|\/\d+)?) fps, AAC (\d+) Hz (\d+)ch to match the live input \([^()\r\n]+\)$/u.exec(
			media,
		);
	if (!target) return projected;
	const [numerator, denominator = 1] = (target[3] ?? "").split("/").map(Number);
	const normalized = slateNormalizedKey(source.data.key, {
		width: Number(target[1]),
		height: Number(target[2]),
		frameRate: Number(numerator) / denominator,
		sampleRate: Number(target[4]),
		channels: Number(target[5]),
		channelsAssumed: false,
	});
	const stereo = "; channel count assumed stereo (the live input reports none)";
	const suffix = destination.endsWith(stereo) ? stereo : "";
	const output = destination.slice(0, destination.length - suffix.length);
	const { bucket } = source.data;
	const besideSource = `${bucket}/${normalized}`;
	const onDeliveryOutput = `/slates/${bucket}/${normalized.replace(/^\/+/, "")}`;
	const sourcePart =
		output === besideSource
			? normalized
			: output.endsWith(onDeliveryOutput)
				? normalized.replace(/^\/+/, "")
				: null;
	if (!sourcePart?.includes("@")) return projected;
	// Ignore literal at-signs solely inside the matched, retained source key.
	// This leaves the independent destination, metadata and any query intact.
	const checked =
		prefix +
		media +
		separator +
		output.slice(0, -sourcePart.length) +
		sourcePart.replaceAll("@", "_") +
		suffix;
	return publicStorageDiagnostic(checked) === checked ? note : projected;
}

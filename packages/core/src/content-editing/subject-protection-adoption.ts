import {
	compositionVideoFit,
	resolvePresentedCompositionGeometry,
} from "./composition-presentation";
import type {
	AnyEditDocument,
	CompositionClip,
	CompositionDocument,
} from "./composition-schema";
import { type EditFraming, MAX_EDIT_FRAMING_SEGMENTS } from "./schema";
import {
	createSubjectPresentationAdoption,
	hasCurrentSubjectPresentationAdoption,
} from "./subject-presentation-adoption";
import { compositionSubjectProtectionContext } from "./subject-protection";
import { hashEditingEvidence } from "./verify-automatic-binding";

export class SubjectProtectionAdoptionError extends Error {
	readonly code = "SUBJECT_PROTECTION_ADOPTION_LIMIT";
	constructor() {
		super("SUBJECT_PROTECTION_ADOPTION_LIMIT");
	}
}

function usesSourcePreservation(
	document: CompositionDocument,
	clip: CompositionClip,
) {
	return (
		compositionVideoFit(document, clip) === "AUTO" &&
		document.presentation?.fallbackFraming === "PRESERVE_SOURCE_V1"
	);
}
const equal = (a: unknown, b: unknown) =>
	hashEditingEvidence(a) === hashEditingEvidence(b);

/** Read only the stored document: request-supplied observations never authorize
 * a manual view. This is presentation adoption, not refreshed native evidence. */
function storedManualView(
	document: CompositionDocument,
	clip: CompositionClip,
) {
	if (!usesSourcePreservation(document, clip)) return undefined;
	if (hasCurrentSubjectPresentationAdoption(document, clip))
		return structuredClone(clip);
	const binding = document.autoGeneration?.binding;
	if (!clip.subjectProtection || !binding) return undefined;
	const framing: EditFraming[] = [];
	for (let frame = 0; frame < clip.durationFrames; frame++) {
		const part = clip.framing.find(
			(value) => frame >= value.fromFrame && frame < value.toFrame,
		);
		if (!part) throw new RangeError("Missing framing during subject adoption");
		let adopted: EditFraming = {
			fromFrame: frame,
			toFrame: frame + 1,
			mode: "FIT",
			origin: "MANUAL",
			manualOverride: true,
		};
		if (part.mode === "CROP") {
			const geometry = resolvePresentedCompositionGeometry({
				document,
				clip,
				frame,
				sourceWidth: binding.width,
				sourceHeight: binding.height,
				width: document.canvas.width,
				height: document.canvas.height,
			});
			if (
				geometry.sourceRect.x !== 0 ||
				geometry.sourceRect.y !== 0 ||
				geometry.sourceRect.w !== binding.width ||
				geometry.sourceRect.h !== binding.height
			)
				adopted = {
					...part,
					fromFrame: frame,
					toFrame: frame + 1,
					origin: "MANUAL",
					manualOverride: true,
				};
		}
		const previous = framing.at(-1);
		const signature = ({
			fromFrame: _from,
			toFrame: _to,
			...value
		}: EditFraming) => hashEditingEvidence(value);
		if (previous && signature(previous) === signature(adopted))
			previous.toFrame = frame + 1;
		else framing.push(adopted);
	}
	const adopted = { ...structuredClone(clip), framing };
	delete adopted.subjectProtection;
	delete adopted.subjectPresentationAdoption;
	if (framing.some((part) => part.mode === "CROP"))
		adopted.subjectPresentationAdoption = createSubjectPresentationAdoption(
			document,
			adopted,
			hashEditingEvidence(clip.subjectProtection),
		);
	return adopted;
}

export function normalizeManualSubjectProtectionEdits<
	T extends AnyEditDocument,
>(original: AnyEditDocument | undefined, next: T): T {
	const document = structuredClone(next);
	if (document.schemaVersion !== 2) return document;
	for (const clip of document.clips) {
		const requestedProof = clip.subjectProtection;
		const requestedAdoption = clip.subjectPresentationAdoption;
		delete clip.subjectProtection;
		delete clip.subjectPresentationAdoption;
		const stored =
			original?.schemaVersion === 2
				? original.clips.find((value) => value.id === clip.id)
				: undefined;
		if (
			!stored ||
			original?.schemaVersion !== 2 ||
			!usesSourcePreservation(document, clip)
		)
			continue;
		if (
			requestedProof &&
			(!stored.subjectProtection ||
				!equal(requestedProof, stored.subjectProtection))
		)
			continue;
		const base = storedManualView(original, stored);
		if (!base) continue;
		if (
			requestedProof &&
			!requestedAdoption &&
			equal(
				compositionSubjectProtectionContext(original, stored) ?? null,
				compositionSubjectProtectionContext(document, clip) ?? null,
			)
		) {
			clip.framing = base.framing;
			if (base.subjectPresentationAdoption)
				clip.subjectPresentationAdoption = base.subjectPresentationAdoption;
			continue;
		}
		const authorized = base.subjectPresentationAdoption;
		if (!requestedAdoption || !authorized) continue;
		const expected = createSubjectPresentationAdoption(
			document,
			clip,
			authorized.proofHash,
		);
		if (
			!expected ||
			expected.sourceBindingHash !== authorized.sourceBindingHash ||
			clip.framing.some(
				(part) =>
					part.mode === "CROP" &&
					(part.origin !== "MANUAL" || part.manualOverride !== true),
			)
		)
			continue;
		// Explicit coordinate edits can carry the stored marker or the same marker
		// already re-pinned by the preview helper. No unrelated marker is accepted.
		if (
			equal(requestedAdoption, authorized) ||
			equal(requestedAdoption, expected)
		)
			clip.subjectPresentationAdoption = expected;
	}
	if (
		document.clips.reduce((sum, clip) => sum + clip.framing.length, 0) >
		MAX_EDIT_FRAMING_SEGMENTS
	)
		throw new SubjectProtectionAdoptionError();
	return document;
}

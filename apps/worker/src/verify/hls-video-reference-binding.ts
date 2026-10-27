import { createFilenameMatcher, type ExpectedManifest } from "@bitovp/core";
import type { Check, ParsedHls } from "./engine";

type Media = NonNullable<ExpectedManifest["hlsAdditionalMedia"]>[number];
export type HlsVideoReferences = {
	check: Check;
	objects: {
		key: string;
		reference: string;
		init: boolean;
		range?: { offset?: number; length?: number };
	}[];
};

/** Construct a URL from an object key without treating literal percent tokens as escapes. */
export function storageObjectUrl(root: URL, key: string): URL {
	return new URL(
		key.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/"),
		root,
	);
}

/** Resolve one URI and decode its object key once; malformed escapes remain unverified. */
export function referencedObjectKey(
	reference: string,
	playlist: URL,
	root: URL,
): string | undefined {
	try {
		const resolved = new URL(reference, playlist);
		if (
			resolved.origin !== root.origin ||
			!resolved.pathname.startsWith(root.pathname) ||
			resolved.username ||
			resolved.password
		)
			return undefined;
		return decodeURIComponent(resolved.pathname.slice(root.pathname.length));
	} catch {
		return undefined;
	}
}

/** Bind every reference to the selected clear/encrypted writer, before considering its bytes. */
export function bindHlsVideoReferences(
	id: string,
	media: Pick<Media, "resource">,
	parsed: ParsedHls,
	context: { outputKey: string; playlist: URL; storageRoot: URL },
): HlsVideoReferences {
	const fail = (detail: string): HlsVideoReferences => ({
		check: { id, area: "manifest", verdict: "FAIL", detail },
		objects: [],
	});
	const resource = media.resource;
	if (!resource?.outputKeys.includes(context.outputKey))
		return fail(
			"The VIDEO child is not bound to a declared output of its configured media writer",
		);
	const segments: NonNullable<ParsedHls["mediaSegments"]> =
		parsed.mediaSegments ?? (parsed.segmentUris ?? []).map((uri) => ({ uri }));
	const maps: {
		uri: string;
		byteRange?: { offset?: number; length?: number };
	}[] = parsed.mediaSegments
		? parsed.mediaSegments.flatMap((segment) =>
				segment.map ? [segment.map] : [],
			)
		: parsed.mapUri
			? [{ uri: parsed.mapUri }]
			: [];
	const requiresInit = resource.container !== "TS";
	if (!segments.length || (requiresInit ? !maps.length : maps.length > 0))
		return fail(
			"The configured VIDEO container requires media references and its correct initialization addressing",
		);
	const init =
		resource.container === "MP4"
			? resource.filename
			: resource.initSegmentNameTemplate || resource.initSegment;
	const segment =
		resource.container === "MP4" ? resource.filename : resource.segmentNaming;
	if (segment === undefined || (requiresInit && init === undefined))
		return fail(
			"The configured VIDEO writer has no verifiable filename contract",
		);
	const matchMedia = createFilenameMatcher(segment, {
		policyTokens: resource.container !== "MP4",
		randomTokens: resource.segmentNamingIsTemplate === true,
	});
	const matchInit = createFilenameMatcher(init ?? "", {
		policyTokens: false,
		randomTokens: Boolean(resource.initSegmentNameTemplate),
	});
	const objects: HlsVideoReferences["objects"] = [];
	let unknown = false;
	for (const [references, matcher, init] of [
		[maps, matchInit, true],
		[segments, matchMedia, false],
	] as const) {
		for (const reference of references) {
			const key = referencedObjectKey(
				reference.uri,
				context.playlist,
				context.storageRoot,
			);
			if (key === undefined || !key.startsWith(resource.directory))
				return fail(
					"A VIDEO child reference resolves outside its configured writer directory",
				);
			const matched = matcher(key.slice(resource.directory.length));
			if (matched === "NO_MATCH")
				return fail(
					"A VIDEO child reference does not match its configured writer filename and template policy",
				);
			if (matched === "UNVERIFIED") unknown = true;
			const range = reference.byteRange;
			if (
				range &&
				(!Number.isSafeInteger(range.length) ||
					(range.length ?? 0) <= 0 ||
					!Number.isSafeInteger(range.offset) ||
					(range.offset ?? -1) < 0)
			)
				return fail("A VIDEO child has an invalid byte range");
			if (resource.container === "MP4" && !range)
				return fail(
					"An MP4 VIDEO child must address initialization and media with byte ranges",
				);
			objects.push({
				key,
				reference: reference.uri,
				init,
				...(range ? { range } : {}),
			});
		}
	}
	return {
		check: {
			id,
			area: "manifest",
			verdict: unknown ? "SKIP" : "PASS",
			detail: unknown
				? "VIDEO writer membership exceeded bounded matching; its references remain UNVERIFIED"
				: "Every VIDEO child initialization and media reference belongs to its configured writer",
		},
		objects: unknown ? [] : objects,
	};
}

/** Check every resolved initialization/media reference against its complete object byte size. */
export function checkHlsReferenceObjects(
	id: string,
	references: HlsVideoReferences["objects"],
	listed: readonly { key: string; size?: number }[],
): Check {
	const result = (condition: boolean, detail: string): Check => ({
		id,
		area: "manifest",
		verdict: condition ? "PASS" : "FAIL",
		detail,
	});
	const seen = new Set<string>(),
		sizes = new Map<string, number>(),
		invalid = new Set<string>();
	for (const object of listed) {
		seen.add(object.key);
		if (object.size === undefined) continue;
		const previous = sizes.get(object.key);
		if (
			!Number.isSafeInteger(object.size) ||
			object.size < 0 ||
			(previous !== undefined && previous !== object.size)
		)
			invalid.add(object.key);
		else sizes.set(object.key, object.size);
	}
	if (
		!references.length ||
		references.some(
			(reference) => !seen.has(reference.key) || invalid.has(reference.key),
		)
	)
		return result(
			false,
			"A referenced HLS object is missing or has contradictory storage byte sizes",
		);
	if (
		references.some((object) => {
			const { range } = object;
			if (
				range &&
				(!Number.isSafeInteger(range.offset) ||
					!Number.isSafeInteger(range.length) ||
					(range.offset ?? -1) < 0 ||
					(range.length ?? 0) <= 0)
			)
				return true;
			const size = sizes.get(object.key);
			return (
				size !== undefined &&
				(size === 0 ||
					(range !== undefined &&
						(range.length ?? 0) > size - (range.offset ?? 0)))
			);
		})
	)
		return result(
			false,
			"Every HLS child reference must contain bytes and any byte range must fit its configured output file",
		);
	if (references.some((reference) => !sizes.has(reference.key)))
		return {
			id,
			area: "manifest",
			verdict: "SKIP",
			detail: "HLS references exist, but storage byte sizes were not exposed",
		};
	return result(
		true,
		"Every HLS child reference must contain bytes and any byte range must fit its configured output file",
	);
}

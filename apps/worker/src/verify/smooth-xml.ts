import { XMLParser, XMLValidator } from "fast-xml-parser";

const parser = new XMLParser({
	ignoreAttributes: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
	parseTagValue: false,
	parseAttributeValue: false,
	processEntities: false,
	removeNSPrefix: true,
});

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function rootOf(text: string, name: string) {
	if (/<!DOCTYPE\b/i.test(text)) return undefined;
	try {
		if (XMLValidator.validate(text) !== true) return undefined;
		const document = object(parser.parse(text));
		if (
			!document ||
			!Object.hasOwn(document, name) ||
			Object.keys(document).length !== 1
		)
			return undefined;
		return document[name] === "" ? {} : object(document[name]);
	} catch {
		return undefined;
	}
}

function elements(value: unknown): unknown[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/** A server manifest uses SMIL to reference its media tracks. */
export function smoothServerHasMedia(text: string): boolean {
	const root = rootOf(text, "smil");
	if (!root || !Object.hasOwn(root, "head")) return false;
	const tracks = object(object(root.body)?.switch);
	return ["video", "audio"].some((kind) =>
		elements(tracks?.[kind]).some((item) => {
			const src = object(item)?.["@_src"];
			return typeof src === "string" && src.trim().length > 0;
		}),
	);
}

/** A client manifest describes A/V qualities through StreamIndex children. */
export function smoothClientQualityLevels(text: string): number | undefined {
	const root = rootOf(text, "SmoothStreamingMedia");
	if (!root) return undefined;
	let count = 0;
	for (const item of elements(root.StreamIndex)) {
		const stream = object(item);
		const type = stream?.["@_Type"];
		if (type === "video" || type === "audio")
			count += elements(stream?.QualityLevel).length;
	}
	return count;
}

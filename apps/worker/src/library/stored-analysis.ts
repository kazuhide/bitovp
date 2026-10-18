import type { Readable } from "node:stream";
import { type LibrarySourceView, MAX_SCENE_ANALYSIS_BYTES } from "@bitovp/core";
import {
	type ObjectStorageBrowser,
	UnsupportedBrowseError,
} from "@bitovp/storage";

type Locator = NonNullable<LibrarySourceView["snapshot"]["analysisOutput"]>;
export function createStoredAnalysisReader(
	browserFor: (credentialId: string) => Promise<ObjectStorageBrowser>,
) {
	return async (output: Locator, locale: string): Promise<unknown> => {
		const browser = await browserFor(output.credentialId);
		let stream: Readable | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (!browser.getObject)
				throw new UnsupportedBrowseError("Analysis storage cannot be read");
			const filename =
				locale === "en"
					? output.filename
					: output.filename.replace(/(\.[^.]*)?$/, `_${locale}$1`);
			const key = [output.path.replace(/^\/+|\/+$/g, ""), filename]
				.filter(Boolean)
				.join("/");
			const identity = await browser.headObject?.({
				bucket: output.bucket,
				key,
			});
			if (identity && identity.size > MAX_SCENE_ANALYSIS_BYTES)
				throw new Error("Analysis output exceeds 8 MiB");
			const expect = identity
				? {
						etag: identity.etag,
						versionId: identity.versionId,
						generation: identity.generation,
					}
				: undefined;
			stream = (await browser.getObject({
				bucket: output.bucket,
				key,
				...(expect ? { expect } : {}),
			})) as Readable;
			timer = setTimeout(
				() => stream?.destroy(new Error("Analysis output read timed out")),
				25_000,
			);
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of stream) {
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				if (size > MAX_SCENE_ANALYSIS_BYTES)
					throw new Error("Analysis output exceeds 8 MiB");
				chunks.push(bytes);
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} finally {
			if (timer) clearTimeout(timer);
			stream?.destroy();
			browser.dispose?.();
		}
	};
}

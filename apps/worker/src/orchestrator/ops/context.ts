/**
 * : the closure context every domain factory receives. Built once
 * inside createBitmovinSdkOps (sdk-ops.ts) — `audited` wraps the audit
 * recorder, `id` asserts a response id, `muxings`/`capturePort` are the two
 * shared API shortcuts. Domain factories destructure ONLY what they use so
 * the member bodies stay byte-identical with their pre-split text.
 */

import type BitmovinApiImport from "@bitmovin/api-sdk";
import type { PerTitleCapturePort } from "@bitovp/core";
import type { AuditRecorder, SdkOpsOptions } from "../sdk-ops";

export type OpsContext = {
	api: BitmovinApiImport;
	options: SdkOpsOptions;
	record: AuditRecorder;
	audited: <T>(
		method: string,
		path: string,
		requestSnapshot: unknown,
		fn: () => Promise<T>,
		responseSnapshot: (result: T) => unknown,
		beforeRecord?: (result: T) => Promise<void>,
	) => Promise<T>;
	stampAuditAdopt: (
		path: string,
	) => (adoptedId: string, phase: "pre" | "post-failure") => Promise<void>;
	id: (r: { id?: string }) => string;
	muxings: () => BitmovinApiImport["encoding"]["encodings"]["muxings"];
	capturePort: PerTitleCapturePort;
};

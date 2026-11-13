import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { MediaOperationError } from "../library-editing/process";
import {
	createVmafResourceLeases,
	type ResourceLeaseRedis,
} from "../vmaf/resource-leases";
import {
	createSharedVmafExecution,
	localVmafHostKey,
} from "../vmaf/shared-execution";
import { VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS } from "./media";

/** Borrow the existing host CPU/RAM coordinator without discovering or requiring a GPU. */
export function createVodInputPreviewReservation(redis: ResourceLeaseRedis) {
	let host: Promise<string> | undefined;
	const executor = createSharedVmafExecution({
		leases: createVmafResourceLeases({ redis }),
		hostKey: () =>
			(host ??=
				process.platform === "linux"
					? localVmafHostKey()
					: Promise.resolve(
							createHash("sha256")
								.update(`bitovp-preview-host:${hostname()}`)
								.digest("hex"),
						)),
	});
	return <T>(
		pixels: number,
		signal: AbortSignal,
		work: (signal: AbortSignal) => Promise<T>,
	) => {
		if (
			!Number.isSafeInteger(pixels) ||
			pixels < 0 ||
			pixels > VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS
		)
			throw new MediaOperationError("RESOURCE_UNAVAILABLE");
		return executor.run(
			{
				threads: 1,
				decoderThreads: 1,
				filterComplexThreads: 1,
				concurrency: 1,
				cpuChargePerComparison: 2,
				estimatedBytes: 256 * 1024 ** 2 + pixels * 80,
				exclusive: false,
				manualFallback: false,
			},
			signal,
			work,
		);
	};
}

/**
 * libvmaf rejects an unresolvable model with a cryptic non-zero exit whose
 * stderr tail is just "Invalid argument". This maps that failure to an
 * actionable message that names the model and the real fix. Shared by the VOD
 * (processor.ts) and live (live-processor.ts) VMAF runners so both surface the
 * same guidance — the "VMAF v1" models load from a bundled model FILE, not a
 * libvmaf upgrade.
 */

/** True when ffmpeg stderr shows libvmaf could not resolve the named model. */
export function isUnresolvableModel(stderr: string): boolean {
	return /no such built-in model|could not load libvmaf model/i.test(stderr);
}

/**
 * Actionable error text for an unresolvable libvmaf model. `modelPath` is set
 * when the runner already tried a bundled file (so the file itself is suspect);
 * otherwise the model resolved to no bundled file and no built-in.
 */
export function unresolvableModelMessage(
	model: string,
	modelPath: string | undefined,
): string {
	return modelPath
		? `VMAF model file "${modelPath}" failed to load for model "${model}" — the bundled JSON may be missing or corrupt.`
		: `VMAF model "${model}" is not a libvmaf built-in. The "VMAF v1" models ` +
				`(vmaf_v1.0.16_3d0h and the other _NdNh / _hfr variants) load from a ` +
				`bundled model FILE — run the Docker worker image (it ships them under ` +
				`VMAF_MODEL_DIR) or set VMAF_MODEL_DIR to a dir holding "${model}.json". ` +
				`The vmaf_v0.6.1 family works as a built-in everywhere.`;
}

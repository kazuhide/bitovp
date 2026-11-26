import { existsSync } from "node:fs";
import { join } from "node:path";
import { isHdrVmafModel } from "@bitovp/core";

/** A separately installed HDR runtime must not replace the SDR model directory. */
export function createVmafModelResolver(directories: {
	sdrDir?: string;
	hdrDir?: string;
}): ((model: string) => string | undefined) | undefined {
	if (!directories.sdrDir && !directories.hdrDir) return undefined;
	return (model) => {
		const directory = isHdrVmafModel(model)
			? (directories.hdrDir ?? directories.sdrDir)
			: directories.sdrDir;
		if (!directory) return undefined;
		const file = join(directory, `${model}.json`);
		return existsSync(file) ? file : undefined;
	};
}

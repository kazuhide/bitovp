import { resolve } from "node:path";
import { BaseSequencer } from "vitest/node";

export default class WebTestSequencer extends BaseSequencer {
	async shard(files) {
		const selected = await super.shard(files);
		const { root, shard } = this.ctx.config;
		if (shard.count !== 4) return selected;
		// This 64-case file cost 151–161 s in the measured three-worker runs.
		// Keep the other assignments and the inherited sort unchanged.
		const heavy = resolve(root, "src/app/vod/new/file-flow.mount.test.tsx");
		const isHeavy = (spec) => resolve(root, spec.moduleId) === heavy;
		const rest = selected.filter((spec) => !isHeavy(spec));
		return shard.index === 1 ? [...rest, ...files.filter(isHeavy)] : rest;
	}
}

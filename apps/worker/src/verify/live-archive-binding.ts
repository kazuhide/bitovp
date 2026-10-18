import assert from "node:assert/strict";
import {
	compileLiveChannel,
	type LiveChannelPlan,
	type StepLogEntry,
} from "@bitovp/core";

/** Compare the submitted plan's direct MP4 contract against this encoding's immutable run log. */
export function bindLiveArchive(
	plan: LiveChannelPlan,
	steps: StepLogEntry[],
	encodingId: string,
	muxingKey: string,
	outputKey: string,
) {
	const one = (step: string) => {
		const matches = steps.filter((s) => s.step === step && s.status === "DONE");
		assert.equal(matches.length, 1);
		const value = matches[0];
		assert.ok(value?.resourceId);
		return value as StepLogEntry & { resourceId: string };
	};
	assert.equal(one("encoding").resourceId, encodingId);
	const actual = one(`muxing:${muxingKey}`);
	const expected = compileLiveChannel(plan).find((s) => s.step === actual.step);
	assert.equal(actual.kind, "CREATE_MUXING_MP4");
	assert.ok(expected);
	assert.deepEqual(actual.refs, expected.refs);
	for (const key of ["filename", "outputPath", "mirrorOutputPaths", "acl"])
		assert.deepEqual(actual.payload[key], expected.payload[key]);
	const output = plan.outputs.find((o) => o.key === outputKey);
	assert.ok(output && (output.kind === "S3" || output.kind === "GENERIC_S3"));
	const outputStep = one(`output:${outputKey}`);
	assert.equal(outputStep.payload.credentialId, output.credentialId);
	assert.equal(outputStep.payload.bucketName, output.bucket);
	const outputs = [
		expected.refs?.outputId,
		...(expected.refs?.mirrorOutputIds ?? []),
	];
	assert.ok(outputs.includes(outputStep.step));
	const streamRefs = [
		expected.refs?.streamId,
		...(expected.refs?.additionalStreamIds ?? []),
	];
	assert.ok(streamRefs.every((s): s is string => typeof s === "string"));
	const muxing = plan.muxings.find((m) => m.key === muxingKey);
	assert.ok(muxing?.kind === "MP4");
	const codecs = [muxing.streamKey, ...(muxing.additionalStreamKeys ?? [])].map(
		(key) => {
			const codec = plan.renditions.find((r) => r.key === key)?.codec;
			assert.ok(codec === "H264" || codec === "AAC");
			return codec.toLowerCase();
		},
	);
	const normalize = (v: string) => v.replace(/^\/+|\/+$/g, "");
	const outputPath = normalize(String(expected.payload.outputPath ?? ""));
	assert.ok(!outputPath.split("/").includes(".."));
	return {
		muxingId: actual.resourceId,
		outputId: outputStep.resourceId,
		streamIds: streamRefs.map((s) => one(s).resourceId),
		output,
		codecs,
		outputPath,
		filename: muxing.filename,
		key: outputPath ? `${outputPath}/${muxing.filename}` : muxing.filename,
	};
}

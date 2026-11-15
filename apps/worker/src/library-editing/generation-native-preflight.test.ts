import { expect, it, vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import { MediaOperationError } from "./process";

it("refuses missing native prerequisites before analysis progress or project publication", async () => {
	const f = generationDependencyFixture("TRACK");
	const preflight = vi
		.fn()
		.mockRejectedValue(new MediaOperationError("NATIVE_PREFLIGHT_MEDIA_TOOLS"));
	const onProgress = vi.fn();
	await expect(
		createLibraryGenerationHandler({ prisma: f.prisma, preflight })({
			...f.context,
			onProgress,
		}),
	).rejects.toMatchObject({ code: "NATIVE_PREFLIGHT_MEDIA_TOOLS" });
	expect(preflight).toHaveBeenCalledExactlyOnceWith(
		f.context.parameters,
		f.context.signal,
	);
	expect(onProgress).not.toHaveBeenCalled();
});

import { describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "./process-runner";

/**
 * The real runner over real processes (rev429 R1): `run` must settle when its
 * abort signal fires, not when the child would have finished on its own — the
 * loop normalizer can transcode for minutes, and a STOP has to end it.
 */
describe("createNodeProcessRunner().run", () => {
	it("returns the exit code and buffered output of a finished child", async () => {
		const runner = createNodeProcessRunner();
		const result = await runner.run("sh", [
			"-c",
			"printf out; printf err 1>&2; exit 3",
		]);
		expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
	});

	it("an aborted signal ends a long-running child promptly with code null", async () => {
		const runner = createNodeProcessRunner();
		const aborter = new AbortController();
		const startedAt = Date.now();
		const pending = runner.run("sleep", ["30"], { signal: aborter.signal });
		setTimeout(() => aborter.abort(), 50);
		const result = await pending;
		expect(result.code).toBeNull();
		expect(result.stderr).toMatch(/abort/i);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});
});

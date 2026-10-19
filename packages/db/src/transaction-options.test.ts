import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("native statement timeout transactions", () => {
	const events: string[] = [];
	const calls: {
		input: unknown;
		options: unknown;
		result: Promise<unknown>;
	}[] = [];
	let setupFailure = false;
	function command(value: unknown, label: string) {
		return {
			[Symbol.toStringTag]: "PrismaPromise",
			// biome-ignore lint/suspicious/noThenProperty: model native lazy PrismaPromise execution in batch transactions.
			then(
				resolve: (value: unknown) => unknown,
				reject: (error: unknown) => unknown,
			) {
				events.push(label);
				return (
					setupFailure && label === "setup"
						? Promise.reject(new Error("setup refused"))
						: Promise.resolve(value)
				).then(resolve, reject);
			},
		};
	}
	async function client() {
		vi.resetModules();
		vi.doMock("../generated/client", () => ({
			Prisma: { DbNull: {} },
			PrismaClient: class {
				$queryRaw(strings: TemplateStringsArray, value: unknown) {
					expect(strings.join("?")).toBe(
						"SELECT set_config('statement_timeout', ?, true)",
					);
					expect(value).toMatch(/^(1|123|5000)ms$/);
					return command([{ set_config: value }], "setup");
				}
				$transaction(input: unknown, options: unknown) {
					const result = (async () => {
						if (typeof input === "function") return input(this);
						const results: unknown[] = [];
						for (const item of input as unknown[]) results.push(await item);
						return results;
					})();
					calls.push({ input, options, result });
					return result;
				}
			},
		}));
		return (await import("./client")).createPrismaClient();
	}
	beforeEach(() => {
		events.length = 0;
		calls.length = 0;
		setupFailure = false;
		const shared = globalThis as unknown as { prismaModule?: unknown };
		shared.prismaModule = undefined;
	});
	afterEach(() => {
		vi.doUnmock("../generated/client");
		vi.resetModules();
	});

	it("forwards the unchanged native input, options and promise when not opted in", async () => {
		const db = await client();
		const input = [command("first", "first")] as never;
		const options = { isolationLevel: "Serializable" } as const;
		const result = db.$transaction(input, options);
		expect(calls[0]?.input).toBe(input);
		expect(calls[0]?.options).toBe(options);
		expect(result).toBe(calls[0]?.result);
		await expect(result).resolves.toEqual(["first"]);
		expect(events).toEqual(["first"]);
		const callback = async () => 9;
		const callbackResult = db.$transaction(callback);
		expect(calls[1]?.input).toBe(callback);
		expect(callbackResult).toBe(calls[1]?.result);
		await expect(callbackResult).resolves.toBe(9);
	});

	it("sets a callback timeout before work and forwards only native options", async () => {
		const db = await client();
		await expect(
			db.$transaction(
				async () => {
					events.push("callback");
					return 7;
				},
				{
					statementTimeoutMs: 123,
					timeout: 30000,
					maxWait: 2000,
					isolationLevel: "RepeatableRead",
				},
			),
		).resolves.toBe(7);
		expect(events).toEqual(["setup", "callback"]);
		expect(calls[0]?.options).toEqual({
			timeout: 30000,
			maxWait: 2000,
			isolationLevel: "RepeatableRead",
		});
	});

	it("keeps native batch commands lazy, ordered and removes only the setup result", async () => {
		const db = await client();
		const commands = [command({ first: true }, "first"), command(2, "second")];
		expect(events).toEqual([]);
		await expect(
			db.$transaction(commands as never, {
				statementTimeoutMs: 123,
				isolationLevel: "Serializable",
			}),
		).resolves.toEqual([{ first: true }, 2]);
		expect(events).toEqual(["setup", "first", "second"]);
		expect(calls[0]?.options).toEqual({ isolationLevel: "Serializable" });
		expect(commands).toHaveLength(2);
		await expect(
			db.$transaction([], { statementTimeoutMs: 123 }),
		).resolves.toEqual([]);
	});

	it.each([
		0,
		5001,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		null,
		"123",
	])("rejects invalid timeout %s before starting native work", async (value) => {
		const db = await client();
		await expect(
			Promise.resolve().then(() =>
				db.$transaction(async () => events.push("callback"), {
					statementTimeoutMs: value,
				} as never),
			),
		).rejects.toThrow(/statementTimeoutMs/);
		await expect(
			Promise.resolve().then(() =>
				db.$transaction(
					[command(1, "first")] as never,
					{ statementTimeoutMs: value } as never,
				),
			),
		).rejects.toThrow(/statementTimeoutMs/);
		expect(calls).toHaveLength(0);
		expect(events).toEqual([]);
	});

	it.each([
		1, 5000,
	])("accepts the inclusive statement timeout boundary %i", async (statementTimeoutMs) => {
		const db = await client();
		await expect(
			db.$transaction(async () => 1, { statementTimeoutMs }),
		).resolves.toBe(1);
		expect(events).toEqual(["setup"]);
	});

	it("strips an explicitly undefined custom option without adding setup", async () => {
		const db = await client();
		await db.$transaction(async () => 1, {
			statementTimeoutMs: undefined,
			timeout: 30000,
		});
		expect(calls[0]?.options).toEqual({ timeout: 30000 });
		expect(events).toEqual([]);
	});

	it("does not run callback or batch commands after setup failure", async () => {
		const db = await client();
		setupFailure = true;
		await expect(
			db.$transaction(async () => events.push("callback"), {
				statementTimeoutMs: 123,
			}),
		).rejects.toThrow("setup refused");
		await expect(
			db.$transaction([command(1, "first")] as never, {
				statementTimeoutMs: 123,
			}),
		).rejects.toThrow("setup refused");
		expect(events).toEqual(["setup", "setup"]);
	});
});

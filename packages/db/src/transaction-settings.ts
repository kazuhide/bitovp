import type { AppTransactionClient } from "./client";

/** Keep the application option out of Prisma's native transaction options. */
export function transactionSettings(options: unknown): {
	nativeOptions: unknown;
	statementTimeoutMs?: number;
} {
	if (
		!options ||
		typeof options !== "object" ||
		!("statementTimeoutMs" in options)
	)
		return { nativeOptions: options };
	const { statementTimeoutMs, ...nativeOptions } = options;
	if (
		statementTimeoutMs !== undefined &&
		(typeof statementTimeoutMs !== "number" ||
			!Number.isInteger(statementTimeoutMs) ||
			statementTimeoutMs < 1 ||
			statementTimeoutMs > 5000)
	)
		throw new Error("statementTimeoutMs must be an integer from 1 to 5000");
	return { nativeOptions, statementTimeoutMs };
}

/** Return the native lazy promise so it can also lead a native batch. */
export function setStatementTimeout(
	tx: Pick<AppTransactionClient, "$queryRaw">,
	milliseconds: number,
) {
	return tx.$queryRaw`SELECT set_config('statement_timeout', ${`${milliseconds}ms`}, true)`;
}

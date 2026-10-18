/**
 * `verify smoke` — one command that crosses the seam, before the corpus costs anything.
 *
 * This exists because the harness spent its entire development unable to reach the product,
 * and nothing in the repo could see it. Three defects, all in the path from runner to
 * product, all invisible to every test here:
 *
 *   the compose `web` service had no `ALLOWED_ORIGIN_HOSTS`, so every request came back
 *   `{"error":"Host is not allowed"}`
 *
 *   the nightly job started only postgres, redis and worker — and `VERIFY_BASE_URL`
 *   defaults to the worker's own loopback, so there was nothing at the other end
 *
 *   no `VERIFY_PASSWORD` was passed, so every submit returned `401 Authentication required`
 *   and a full corpus run reported PASS 0 · SKIP 32 · INVALID 41: forty-one identical
 *   401s with no hint that one unset variable was the cause
 *
 * Why nothing caught them: every runner test injects `api`, and every engine test injects
 * `EngineDeps`. Both are the right seams for what they verify, and neither can see a runner
 * that cannot connect. The dry run cannot either, because it stops before submitting. The
 * injected-dependency design that made the engine testable is the same design that made this
 * seam invisible — which is not an argument against injected deps, but an argument that a
 * harness needs at least ONE test that crosses the seam.
 *
 * So this is deliberately end-to-end and deliberately cheap: it reaches the product, signs
 * in, reads its own listing back through the real storage driver, and stops. No encoding, no
 * bill. It answers "can this harness see anything at all", which is the question a corpus run
 * cannot answer for itself — a blind run reports INVALID, which is honest but expensive.
 *
 * Run it before a corpus and from the nightly. If it fails, nothing after it means anything.
 */

import { cipherFromEnv } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { createCredentialStore } from "@bitovp/db";
import { createBrowserForCredential } from "@bitovp/storage";
import { resolveBaseUrl } from "./harness-rails";
import { storageEnv } from "./runner";

export type SmokeConfig = {
	prisma: AppPrismaClient;
	baseUrl: string;
	password?: string;
	/** I-09: Bearer token — preferred over the password flow. */
	apiToken?: string;
	s3CredentialLabel: string;
	inputBucket: string;
	outputBucket: string;
	sourceObject: string;
	log?: (line: string) => void;
};

/**
 * The smoke command's whole decision, in a function a test can reach.
 *
 * Two reasons it is not inline in `scripts/verify.ts`. The first is the one
 * `runCleanCommand` was extracted for: a branch in that file IS the wiring, and
 * a clean revert of it leaves the suite green. The second is the defect this
 * fixes — the branch built `baseUrl` from `process.env.VERIFY_BASE_URL`
 * directly, so the origin allowlist that `verify run` gained (re-audit HIGH-6)
 * never applied to the command the nightly runs FIRST, and step 2 below posts
 * `VERIFY_PASSWORD` to it. Resolving through `resolveBaseUrl` makes the refusal
 * the smoke's own behaviour rather than a rule someone remembered to call.
 *
 * `storageEnv` is shared with the runner for the reason recorded there: the
 * smoke exists to be believed, so it must read the values the corpus will.
 */
export function smokeConfigFromEnv(
	env: NodeJS.ProcessEnv,
):
	| { ok: true; config: Omit<SmokeConfig, "prisma" | "log"> }
	| { ok: false; reason: string } {
	const policy = resolveBaseUrl(env);
	if (!policy.ok) {
		return { ok: false, reason: policy.reason };
	}
	return {
		ok: true,
		config: {
			baseUrl: policy.url,
			...(env.VERIFY_PASSWORD ? { password: env.VERIFY_PASSWORD } : {}),
			...(env.VERIFY_API_TOKEN ? { apiToken: env.VERIFY_API_TOKEN } : {}),
			...storageEnv(env),
		},
	};
}

export type SmokeStep = {
	name: string;
	ok: boolean;
	/** What was observed — the failure's own words, never a paraphrase. */
	detail: string;
	/** What to change, when the step can name it. */
	fix?: string;
};

export type SmokeResult = { steps: SmokeStep[]; ok: boolean };

/**
 * Every prerequisite, checked in the order that makes a failure readable.
 *
 * Ordered so the FIRST failure is the root cause: there is no point reporting "cannot submit"
 * when the real answer is "cannot resolve the host". Each step's `fix` names the variable or
 * service to change, because "connection refused" without that is a guessing game — and the
 * three defects above were each one variable.
 */
export async function verifySmoke(config: SmokeConfig): Promise<SmokeResult> {
	const log = config.log ?? (() => {});
	const steps: SmokeStep[] = [];
	const add = (step: SmokeStep) => {
		steps.push(step);
		log(`  ${step.ok ? "ok  " : "FAIL"} ${step.name} — ${step.detail}`);
		return step.ok;
	};

	// 1. Is anything listening, and does it accept our Host header? These are different
	//    failures with the same symptom, so the health body is read rather than the status.
	let health: { status: number; body: string };
	try {
		const res = await fetch(`${config.baseUrl}/api/health`);
		health = { status: res.status, body: (await res.text()).slice(0, 200) };
	} catch (err) {
		add({
			name: "reach the product",
			ok: false,
			detail: `${config.baseUrl}/api/health: ${err instanceof Error ? err.message : String(err)}`,
			fix: "check VERIFY_BASE_URL and that the `web` service is running — the nightly job started only postgres/redis/worker for months, and the default 127.0.0.1:3100 is the worker's own loopback",
		});
		return { steps, ok: false };
	}
	if (/Host is not allowed/i.test(health.body)) {
		add({
			name: "reach the product",
			ok: false,
			detail: `${config.baseUrl} answered but rejected the Host header: ${health.body}`,
			fix: "add this hostname to ALLOWED_ORIGIN_HOSTS on the web service — it was unset on the compose `web` service, so the entire harness talked to a door that would not open",
		});
		return { steps, ok: false };
	}
	if (
		!add({
			name: "reach the product",
			ok: health.status === 200,
			detail: `${config.baseUrl}/api/health → ${health.status} ${health.body}`,
		})
	) {
		return { steps, ok: false };
	}

	// 2. Can we authenticate? A corpus without this reports one INVALID per scenario and
	//    names none of them the cause.
	let session: string | undefined;
	if (config.apiToken) {
		add({
			name: "sign in",
			ok: true,
			detail: "VERIFY_API_TOKEN set — requests ride Authorization: Bearer",
		});
	} else if (config.password) {
		const res = await fetch(`${config.baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: config.password }),
		});
		const cookies = res.headers.getSetCookie?.() ?? [];
		session = cookies.map((c) => c.split(";")[0]).join("; ");
		if (
			!add({
				name: "sign in",
				ok: res.ok && session.length > 0,
				detail: res.ok
					? `session cookie ${session.length > 0 ? "received" : "MISSING"}`
					: `HTTP ${res.status}`,
				fix: "set VERIFY_PASSWORD, or run against an instance with AUTH_MODE=none",
			})
		) {
			return { steps, ok: false };
		}
	} else {
		add({
			name: "sign in",
			ok: true,
			detail:
				"no VERIFY_PASSWORD set — assuming AUTH_MODE=none; the next step proves it",
		});
	}

	// 3. Does an authenticated read actually work? `/api/health` is public, so a 200 there
	//    says nothing about the session. This is the step that turns a silent 401 into a
	//    named one.
	const listRes = await fetch(`${config.baseUrl}/api/encoding-jobs?limit=1`, {
		headers: config.apiToken
			? { authorization: `Bearer ${config.apiToken}` }
			: session
				? { cookie: session }
				: {},
	});
	const listBody = (await listRes.text()).slice(0, 200);
	if (
		!add({
			name: "authenticated read",
			ok: listRes.ok,
			detail: `GET /api/encoding-jobs → ${listRes.status} ${listBody}`,
			fix: "a 401 here is why a corpus run returns one INVALID per scenario — fix the credential before spending encoder minutes",
		})
	) {
		return { steps, ok: false };
	}

	// 4. The credential the rewrite points every scenario at.
	const rows = await config.prisma.credential.findMany({
		select: { id: true, label: true },
	});
	const credential = rows.find((c) =>
		c.label.startsWith(config.s3CredentialLabel),
	);
	if (
		!add({
			name: "storage credential",
			ok: credential !== undefined,
			detail: credential
				? `${credential.label}`
				: `no credential whose label starts with "${config.s3CredentialLabel}" (${rows.length} registered)`,
			fix: "register one in 設定 → 資格情報",
		}) ||
		!credential
	) {
		return { steps, ok: false };
	}

	// 5. And can it actually READ? A registered credential that cannot list is the same
	//    failure as no credential, arriving later and less clearly.
	try {
		const credentials = createCredentialStore(config.prisma, cipherFromEnv());
		const row = await credentials.get(credential.id);
		if (!row) {
			throw new Error("the credential row vanished between queries");
		}
		const browser = createBrowserForCredential({
			provider: row.provider,
			config: (row.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(credential.id),
			) as Record<string, string>,
		});
		const page = await browser.listObjects({
			bucket: config.outputBucket,
			prefix: "verify/",
			limit: 100,
		});
		browser.dispose?.();
		/**
		 * Both counts, because `objects.length` alone lies here.
		 *
		 * A non-recursive list sets `Delimiter: "/"`, so every past run's artefacts collapse into
		 * `prefixes` and NONE of them appear in `objects`. This step reported "0 object(s) under
		 * verify/" on a bucket holding three completed runs — technically true, and it reads as an
		 * empty bucket. A reassuring wrong number is the failure mode this whole harness keeps
		 * being bitten by, so the line now says what it actually saw.
		 */
		const runs = page.prefixes.length;
		add({
			name: "list the output bucket",
			ok: true,
			detail: `${config.outputBucket} reachable — ${runs} previous run prefix(es) and ${page.objects.length} loose object(s) under verify/ (a non-recursive list collapses each run into a prefix, so 0 loose objects is normal)`,
		});
	} catch (err) {
		add({
			name: "list the output bucket",
			ok: false,
			detail: `${config.outputBucket}: ${err instanceof Error ? err.message : String(err)}`,
			fix: "a MASTER_KEY that cannot decrypt the credential looks exactly like a bad credential here — check both",
		});
		return { steps, ok: false };
	}

	// 6. And the source every rewritten scenario reads. Missing it fails every scenario for
	//    the same reason, which is the shape a smoke exists to pre-empt.
	try {
		const credentials = createCredentialStore(config.prisma, cipherFromEnv());
		const row = await credentials.get(credential.id);
		if (!row) {
			throw new Error("the credential row vanished between queries");
		}
		const browser = createBrowserForCredential({
			provider: row.provider,
			config: (row.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(credential.id),
			) as Record<string, string>,
		});
		/**
		 * List the object's DIRECTORY, not the object itself.
		 *
		 * `s3.ts` deliberately drops any key equal to the prefix — "the prefix itself can
		 * appear as a zero-byte object marker" — so passing a full object key as the prefix
		 * always returns nothing, and my first version reported a missing source for a file
		 * that is plainly there: the running corpus had already FINISHED three encodings
		 * reading it. A smoke that cries wolf is worse than no smoke, because the next real
		 * failure gets ignored.
		 */
		const slash = config.sourceObject.lastIndexOf("/");
		const dir = slash >= 0 ? config.sourceObject.slice(0, slash + 1) : "";
		const page = await browser.listObjects({
			bucket: config.inputBucket,
			prefix: dir,
			limit: 100,
		});
		browser.dispose?.();
		const found = page.objects.some((o) => o.key === config.sourceObject);
		add({
			name: "the source object exists",
			ok: found,
			detail: found
				? `${config.inputBucket}/${config.sourceObject}`
				: `${config.inputBucket}/${config.sourceObject} not found`,
			fix: "every rewritten scenario reads this one object; without it all of them fail identically",
		});
	} catch (err) {
		add({
			name: "the source object exists",
			ok: false,
			detail: `${config.inputBucket}: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	return { steps, ok: steps.every((x) => x.ok) };
}

/** Human-readable, and the fix is part of the output rather than something to go and find. */
export function formatSmoke(result: SmokeResult): string {
	const lines = ["# verify smoke", ""];
	for (const step of result.steps) {
		lines.push(`${step.ok ? "ok  " : "FAIL"}  ${step.name}`);
		lines.push(`      ${step.detail}`);
		if (!step.ok && step.fix) {
			lines.push(`      fix: ${step.fix}`);
		}
	}
	lines.push("");
	lines.push(
		result.ok
			? "The harness can reach the product, authenticate, and read its own storage. A corpus run's results will mean something."
			: "STOP. The first FAIL above is the root cause; nothing after a corpus run would mean anything until it is fixed.",
	);
	return lines.join("\n");
}

import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
	it("accepts only the unrestricted deployment and rejects retired or unknown values", () => {
		for (const value of [undefined, "", "UNRESTRICTED"]) {
			expect(loadEnv({ DEPLOYMENT_PROFILE: value }).DEPLOYMENT_PROFILE).toBe(
				"UNRESTRICTED",
			);
		}
		for (const value of ["AKAMAI_ONLY", "UNKNOWN_PROFILE"]) {
			expect(() => loadEnv({ DEPLOYMENT_PROFILE: value })).toThrow(
				/DEPLOYMENT_PROFILE/,
			);
		}
	});
	it("keeps internal HEVC v2 disabled unless an exact account UUID is configured", () => {
		expect(loadEnv({}).BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID).toBeUndefined();
		expect(
			loadEnv({ BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID: "" })
				.BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
		).toBeUndefined();
		expect(() =>
			loadEnv({ BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID: "main" }),
		).toThrow(/Invalid environment/);
		expect(
			loadEnv({
				BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID:
					"00000000-0000-4000-8000-0000000000aa",
			}).BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
		).toBe("00000000-0000-4000-8000-0000000000aa");
	});
	it("falls back to docker-compose defaults", () => {
		const env = loadEnv({});
		expect(env.NODE_ENV).toBe("development");
		expect(env.DATABASE_URL).toBe(
			"postgresql://bitovp_runtime@localhost:5432/bitovp",
		);
		expect(env.REDIS_URL).toBe("redis://localhost:6379");
	});

	it("uses provided values over defaults", () => {
		const env = loadEnv({
			NODE_ENV: "production",
			DATABASE_URL: "postgresql://u:p@db:5432/app",
			REDIS_URL: "redis://cache:6379",
		});
		expect(env.NODE_ENV).toBe("production");
		expect(env.DATABASE_URL).toBe("postgresql://u:p@db:5432/app");
		expect(env.REDIS_URL).toBe("redis://cache:6379");
	});

	it("defaults ffmpeg/ffprobe to PATH lookup and leaves the spool unset", () => {
		const env = loadEnv({});
		expect(env.FFMPEG_PATH).toBe("ffmpeg");
		expect(env.FFPROBE_PATH).toBe("ffprobe");
		expect(env.FEEDER_SPOOL_DIR).toBeUndefined();
		expect(loadEnv({ FFMPEG_PATH: "/opt/ffmpeg/bin/ffmpeg" }).FFMPEG_PATH).toBe(
			"/opt/ffmpeg/bin/ffmpeg",
		);
	});

	it("rejects an unknown NODE_ENV", () => {
		expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow(
			/Invalid environment/,
		);
	});

	it("treats blank values as unset (template .env with KEY= lines)", () => {
		// Regression: a copied .env.example with BITMOVIN_WEBHOOK_SECRET=
		// (blank) crashed the worker at boot.
		const env = loadEnv({
			DATABASE_URL: "",
			BITMOVIN_WEBHOOK_SECRET: "",
			PUBLIC_BASE_URL: "",
		});
		expect(env.DATABASE_URL).toBe(
			"postgresql://bitovp_runtime@localhost:5432/bitovp",
		);
		expect(env.BITMOVIN_WEBHOOK_SECRET).toBeUndefined();
		expect(env.PUBLIC_BASE_URL).toBeUndefined();
	});

	it("still refuses blank DATABASE_URL in production (blank = unset)", () => {
		expect(() => loadEnv({ NODE_ENV: "production", DATABASE_URL: "" })).toThrow(
			/Missing required env vars in production/,
		);
	});

	it("refuses development defaults in production", () => {
		expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(
			/Missing required env vars in production: DATABASE_URL, REDIS_URL/,
		);
		expect(() =>
			loadEnv({
				NODE_ENV: "production",
				DATABASE_URL: "postgresql://u:p@db:5432/app",
			}),
		).toThrow(/REDIS_URL/);
	});

	it("accepts production with explicit urls", () => {
		const env = loadEnv({
			NODE_ENV: "production",
			DATABASE_URL: "postgresql://u:p@db:5432/app",
			REDIS_URL: "redis://cache:6379",
		});
		expect(env.NODE_ENV).toBe("production");
	});
});

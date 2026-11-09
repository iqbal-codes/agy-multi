import { describe, expect, it } from "bun:test";
import { profileEnvOf } from "../src/registry";
import type { Profile } from "../src/types";

describe("cross-platform environment configuration", () => {
	const sampleProfile: Profile = {
		slug: "test-user",
		createdAt: "2026-11-09T00:00:00Z",
		home: "/Users/test/.agy/profiles/test-user/home",
	};

	it("sets HOME correctly on POSIX platforms (darwin / linux)", () => {
		const baseEnv = { PATH: "/usr/bin", FOO: "bar" };
		const env = profileEnvOf(sampleProfile, baseEnv, "darwin");
		expect(env.HOME).toBe(sampleProfile.home);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.FOO).toBe("bar");
		expect(env.USERPROFILE).toBeUndefined();
		expect(env.HOMEDRIVE).toBeUndefined();
	});

	it("sets USERPROFILE, HOMEPATH, and HOMEDRIVE on Windows", () => {
		const windowsHome = "C:\\Users\\test\\.agy\\profiles\\test-user\\home";
		const baseEnv = { Path: "C:\\Windows\\system32", USERPROFILE: "C:\\Users\\test" };
		const env = profileEnvOf(windowsHome, baseEnv, "win32");
		expect(env.HOME).toBe(windowsHome);
		expect(env.USERPROFILE).toBe(windowsHome);
		expect(env.HOMEPATH).toBe(windowsHome);
		expect(env.HOMEDRIVE).toBe("C:");
		expect(env.Path).toBe("C:\\Windows\\system32");
	});

	it("accepts either a Profile object or a string directory", () => {
		const directHome = "/custom/home/path";
		const env = profileEnvOf(directHome, {}, "linux");
		expect(env.HOME).toBe(directHome);
	});
});

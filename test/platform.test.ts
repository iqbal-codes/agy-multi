import { describe, expect, it } from "bun:test";
import { ISOLATED_LINUX_DBUS_ADDRESS, profileEnvOf } from "../src/registry";
import type { Profile } from "../src/types";

describe("cross-platform environment configuration", () => {
	const adoptedProfile: Profile = {
		slug: "test-user",
		createdAt: "2026-11-09T00:00:00Z",
		home: "/Users/test/.agy/profiles/test-user/home",
	};
	const managedProfile: Profile = {
		slug: "managed-user",
		createdAt: "2026-11-09T00:00:00Z",
	};

	it("sets HOME correctly on POSIX platforms (darwin / linux)", () => {
		const baseEnv = { PATH: "/usr/bin", FOO: "bar" };
		const env = profileEnvOf(adoptedProfile, baseEnv, "darwin");
		expect(env.HOME).toBe(adoptedProfile.home);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.FOO).toBe("bar");
		expect(env.USERPROFILE).toBeUndefined();
		expect(env.HOMEDRIVE).toBeUndefined();
	});

	it("isolates Linux D-Bus Secret Service for managed profiles while preserving REAL_DBUS_SESSION_BUS_ADDRESS", () => {
		const baseEnv = {
			PATH: "/usr/bin",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
		};
		const env = profileEnvOf(managedProfile, baseEnv, "linux");
		expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(ISOLATED_LINUX_DBUS_ADDRESS);
		expect(env.REAL_DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
		expect(env.GNOME_KEYRING_CONTROL).toBeUndefined();
	});

	it("keeps Linux D-Bus untouched for adopted profiles that rely on the system keyring", () => {
		const baseEnv = {
			PATH: "/usr/bin",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
		};
		const env = profileEnvOf(adoptedProfile, baseEnv, "linux");
		expect(env.HOME).toBe(adoptedProfile.home);
		expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
		expect(env.REAL_DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
		expect(env.GNOME_KEYRING_CONTROL).toBe("/run/user/1000/keyring");
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
		expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(ISOLATED_LINUX_DBUS_ADDRESS);
	});
});

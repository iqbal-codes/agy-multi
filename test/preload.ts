/**
 * Keeps the test process off the operator's real state root: importing any
 * module that resolves paths would otherwise read, and on a rename, move
 * `~/.agy-multi`. Fixtures override this per case.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AGY_MULTI_ROOT) {
	process.env.AGY_MULTI_ROOT = mkdtempSync(join(tmpdir(), "agy-multi-test-root-"));
}

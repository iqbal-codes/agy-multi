/**
 * The version this build reports. `package.json` is inlined at bundle time, so a
 * compiled binary carries the version the release workflow bumped before
 * `bun build --compile` — no runtime file lookup, which a single-file binary
 * could not satisfy anyway.
 */
import pkg from "../package.json";

export const VERSION: string = pkg.version;

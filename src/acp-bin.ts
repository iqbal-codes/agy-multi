#!/usr/bin/env bun
import { parseAcpProxyOptions } from "./acp/cli-args";
import { runAcpProxy } from "./acp/server";
import { ensureAgy } from "./setup";

await ensureAgy({ autoInstall: true });
await runAcpProxy(parseAcpProxyOptions(Bun.argv.slice(2)));

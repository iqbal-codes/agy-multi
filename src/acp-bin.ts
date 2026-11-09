#!/usr/bin/env bun
import { runAcpProxy } from "./acp/server";
import { ensureAgy } from "./setup";

await ensureAgy({ autoInstall: true });
const rawArgs = Bun.argv.slice(2).filter((arg: string) => arg !== "--");
await runAcpProxy({ extraArgs: rawArgs });

#!/usr/bin/env node
import { errorEnvelope, WorkkitError, WorkkitErrorCode, } from "@workkit/core";
import { randomUUID } from "node:crypto";
import { parseArgs } from "./args.js";
import { runApprovalCommand } from "./commands/approval/index.js";
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [domain] = args.positionals;
    try {
        const result = domain === "approval"
            ? await runApprovalCommand(args)
            : errorEnvelope({
                code: WorkkitErrorCode.InvalidInput,
                message: `Unsupported domain: ${domain ?? "<empty>"}`,
            }, { requestId: randomUUID() });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    catch (error) {
        const warning = error instanceof WorkkitError
            ? {
                code: error.code,
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
            }
            : {
                code: WorkkitErrorCode.SourceFailed,
                message: error instanceof Error ? error.message : "Unknown error.",
            };
        process.stdout.write(`${JSON.stringify(errorEnvelope(warning, { requestId: randomUUID() }), null, 2)}\n`);
        process.exitCode = 1;
    }
}
await main();
//# sourceMappingURL=index.js.map
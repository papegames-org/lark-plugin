export function parseArgs(argv) {
    const positionals = [];
    const flags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg) {
            continue;
        }
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const key = arg.slice(2);
        const next = argv[index + 1];
        if (next && !next.startsWith("--")) {
            flags[key] = next;
            index += 1;
        }
        else {
            flags[key] = true;
        }
    }
    return { positionals, flags };
}
export function stringFlag(flags, key) {
    const value = flags[key];
    return typeof value === "string" ? value : undefined;
}
//# sourceMappingURL=args.js.map
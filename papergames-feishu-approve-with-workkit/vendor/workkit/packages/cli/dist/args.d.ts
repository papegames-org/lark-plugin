export type ParsedArgs = {
    positionals: string[];
    flags: Record<string, string | boolean>;
};
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined;
//# sourceMappingURL=args.d.ts.map
import { type ParseArgsConfig, parseArgs } from "node:util";
import { defaultConfigPath } from "./config.js";
import { parsing } from "./errors.js";

const GLOBAL_OPTIONS = {
  config: { type: "string" },
  quiet: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type CommandOptions = NonNullable<ParseArgsConfig["options"]>;

type Spec<T extends CommandOptions> = {
  args: string[];
  allowPositionals: true;
  options: typeof GLOBAL_OPTIONS & T;
};

export interface GlobalFlags {
  configPath: string;
  json: boolean;
  help: boolean;
}

/**
 * Parses one subcommand's argv with the global flags always in scope, resolving `--config` to
 * {@link defaultConfigPath} when absent. `--quiet` is process-wide, via `setQuiet` in `run`.
 */
export function parseCommand<const T extends CommandOptions>(
  args: string[],
  options: T = {} as T,
): ReturnType<typeof parseArgs<Spec<T>>> & GlobalFlags {
  const spec: Spec<T> = {
    args,
    allowPositionals: true,
    options: { ...GLOBAL_OPTIONS, ...options },
  };
  const parsed = parsing(() => parseArgs(spec));
  const g = parsed.values as { config?: string; json?: boolean; help?: boolean };
  return {
    ...parsed,
    configPath: g.config ?? defaultConfigPath(),
    json: g.json === true,
    help: g.help === true,
  };
}

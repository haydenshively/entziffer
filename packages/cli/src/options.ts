import { defaultConfigPath } from "./config.js";

export const GLOBAL_OPTIONS = {
  config: { type: "string" },
  quiet: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

export interface GlobalFlags {
  configPath: string;
  quiet: boolean;
  json: boolean;
  help: boolean;
}

export function globals(values: {
  config?: string | undefined;
  quiet?: boolean | undefined;
  json?: boolean | undefined;
  help?: boolean | undefined;
}): GlobalFlags {
  return {
    configPath: values.config ?? defaultConfigPath(),
    quiet: values.quiet === true,
    json: values.json === true,
    help: values.help === true,
  };
}

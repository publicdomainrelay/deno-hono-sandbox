export interface ArgDef {
  type: string;
  env?: string;
  default?: unknown;
  description?: string;
}

export interface CliArgsEnv {
  name?: string;
  description?: string;
  options: Record<string, ArgDef>;
}

export class Command {
  readonly options: Record<string, unknown> = {};
  private readonly args: string[];

  constructor(
    private readonly configPathEnv: string,
    private readonly argsEnv: CliArgsEnv,
    private readonly moduleConfig: Record<string, unknown> | null = null,
    args?: string[],
  ) {
    this.args = args ?? Deno.args;
  }

  async resolve(): Promise<this> {
    const runtimeConfig = await this.loadRuntimeConfig();
    const cliVals = this.parseCliArgs(this.argsEnv, this.args);

    if (cliVals.help) {
      this.printHelp(this.argsEnv);
      Deno.exit(0);
    }

    for (const [key, def] of Object.entries(this.argsEnv.options)) {
      const cliVal = cliVals[key];
      const envVal = def.env ? Deno.env.get(def.env) : undefined;
      const configVal = runtimeConfig?.[key];
      const camelKey = toCamelCase(key);

      if (cliVal !== undefined) {
        this.options[camelKey] = coerce(cliVal, def.type);
      } else if (envVal !== undefined) {
        this.options[camelKey] = coerce(envVal, def.type);
      } else if (configVal !== undefined) {
        this.options[camelKey] = configVal;
      } else if (def.default !== undefined) {
        this.options[camelKey] = def.default;
      }
    }

    return this;
  }

  private async loadRuntimeConfig(): Promise<Record<string, unknown> | null> {
    const envPath = Deno.env.get(this.configPathEnv);
    if (envPath) {
      try {
        return JSON.parse(await Deno.readTextFile(envPath));
      } catch {
        return null;
      }
    }
    return this.moduleConfig;
  }

  private parseCliArgs(
    argsEnv: CliArgsEnv,
    args: string[],
  ): Record<string, string> {
    const result: Record<string, string> = {};
    const flagToKey: Record<string, string> = {};

    for (const [key] of Object.entries(argsEnv.options)) {
      flagToKey[`--${key}`] = key;
    }

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "--help" || arg === "-h") {
        return { help: "true" };
      }

      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const name = arg.slice(0, eqIdx);
        const val = arg.slice(eqIdx + 1);
        const key = flagToKey[name];
        if (key) result[key] = val;
        continue;
      }

      const key = flagToKey[arg];
      if (key) {
        if (argsEnv.options[key].type === "boolean") {
          result[key] = "true";
        } else if (i + 1 < args.length) {
          result[key] = args[++i];
        }
      }
    }

    return result;
  }

  private printHelp(argsEnv: CliArgsEnv): void {
    const name = argsEnv.name ?? "server";
    const lines: string[] = [
      `${name}${argsEnv.description ? " - " + argsEnv.description : ""}`,
      "",
      "Options:",
    ];
    for (const [key, def] of Object.entries(argsEnv.options)) {
      const parts: string[] = [];
      parts.push(`--${key}`);
      if (def.env) parts.push(`$${def.env}`);
      const prefix = `  ${parts.join(", ")}`;
      const suffix = def.default !== undefined
        ? ` (default: ${JSON.stringify(def.default)})`
        : "";
      lines.push(`${prefix}  ${def.description ?? key}${suffix}`);
    }
    console.error(lines.join("\n"));
  }
}

function toCamelCase(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function coerce(val: string, type: string): unknown {
  switch (type) {
    case "number":
      return Number(val);
    case "boolean":
      return val === "true" || val === "1";
    default:
      return val;
  }
}

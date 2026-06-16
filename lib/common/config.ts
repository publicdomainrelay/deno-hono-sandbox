export interface ArgDef {
  type: "string" | "number" | "boolean";
  env?: string;
  default?: unknown;
  description?: string;
}

export function loadConfig(argsDef: Record<string, ArgDef>): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(argsDef)) {
    const envVal = def.env ? Deno.env.get(def.env) : undefined;

    if (envVal !== undefined) {
      config[key] = coerce(envVal, def.type);
    } else if (def.default !== undefined) {
      config[key] = def.default;
    }
  }

  return config;
}

function coerce(val: string, type: "string" | "number" | "boolean"): unknown {
  switch (type) {
    case "number":
      return Number(val);
    case "boolean":
      return val === "true" || val === "1";
    default:
      return val;
  }
}

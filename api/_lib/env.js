import fs from "node:fs";
import path from "node:path";

let localEnvLoaded = false;

const ENV_ALIASES = new Map([
  ["SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL"]],
  ["SUPABASE_PUBLISHABLE_KEY", ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]],
]);

export function loadLocalEnvFile() {
  if (localEnvLoaded) return;
  localEnvLoaded = true;

  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index < 0) return;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (!key || process.env[key]) return;
      if (
        (value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    });
  }
}

export function readEnv(name, fallback = "") {
  loadLocalEnvFile();
  const value = process.env[name];
  if (value != null && value !== "") return String(value);

  const aliases = ENV_ALIASES.get(name) || [];
  for (const alias of aliases) {
    const aliasedValue = process.env[alias];
    if (aliasedValue != null && aliasedValue !== "") return String(aliasedValue);
  }
  return fallback;
}

export function readEnvFlag(name, fallback = false) {
  const value = readEnv(name);
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

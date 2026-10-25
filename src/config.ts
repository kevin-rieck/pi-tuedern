import { readFileSync } from "node:fs";

export interface HarnessConfig {
  enabled: boolean;
  verifyPath: string;
  automaticOnSettle: boolean;
  maxRepairContinuations: number;
  timeoutSeconds: number;
  maxFeedbackCharacters: number;
  recordEvidence: boolean;
  persistRawOutput: false;
  onMissingContract: "report-unavailable";
  onChangeDetectionError: "verify";
  evidenceDir?: string;
  searchRoot?: string;
  projectRoot?: string;
}

const defaults: HarnessConfig = {
  enabled: true, verifyPath: "scripts/verify", automaticOnSettle: false,
  maxRepairContinuations: 2, timeoutSeconds: 300, maxFeedbackCharacters: 12000,
  recordEvidence: true, persistRawOutput: false,
  onMissingContract: "report-unavailable", onChangeDetectionError: "verify",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const path = env.PI_HARNESS_CONFIG;
  const source: unknown = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!source || Array.isArray(source) || typeof source !== "object") throw new Error("Harness config must be an object");
  for (const key of Object.keys(source)) if (!(key in defaults) && !["evidenceDir", "searchRoot", "projectRoot"].includes(key)) throw new Error(`Unknown harness option: ${key}`);
  const config = { ...defaults, ...source } as HarnessConfig;
  for (const key of ["enabled", "automaticOnSettle", "recordEvidence", "persistRawOutput"] as const)
    if (typeof config[key] !== "boolean") throw new Error(`Invalid ${key}`);
  if (config.persistRawOutput !== false || config.onMissingContract !== "report-unavailable" || config.onChangeDetectionError !== "verify") throw new Error("Unsupported harness policy");
  for (const key of ["maxRepairContinuations", "timeoutSeconds", "maxFeedbackCharacters"] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === "maxRepairContinuations" ? 0 : 1)) throw new Error(`Invalid ${key}`);
  for (const key of ["verifyPath", "evidenceDir", "searchRoot", "projectRoot"] as const)
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key])) throw new Error(`Invalid ${key}`);
  if (config.verifyPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(config.verifyPath) || config.verifyPath.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")) throw new Error("Invalid verifyPath");
  if (env.PI_HARNESS_AUTOMATIC !== undefined && !["0", "1"].includes(env.PI_HARNESS_AUTOMATIC)) throw new Error("PI_HARNESS_AUTOMATIC must be 0 or 1");
  if (env.PI_HARNESS_AUTOMATIC !== undefined) config.automaticOnSettle = env.PI_HARNESS_AUTOMATIC === "1";
  for (const [key, variable] of [["searchRoot", "PI_HARNESS_SEARCH_ROOT"], ["projectRoot", "PI_HARNESS_PROJECT_ROOT"]] as const)
    if (env[variable] !== undefined) {
      if (!env[variable]) throw new Error(`Invalid ${variable}`);
      config[key] = env[variable];
    }
  return config;
}

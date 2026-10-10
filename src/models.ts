/**
 * Pure model-selection and model-cache rules, split out of the MCP entry point
 * so they can be unit-tested without booting the server.
 */
import { ZcodeProtocolError, type AvailableModel, type ModelsReadiness } from "./protocol.js";

/**
 * The error thrown when no model can be selected. Wording distinguishes the
 * three causes an operator can act on: missing credentials, a boot still in
 * flight, and a provider that refused the account. With an empty list this is
 * thrown BEFORE any `models[0]` access — there is no TypeError path.
 */
export function noModelsError(readiness?: ModelsReadiness): ZcodeProtocolError {
  switch (readiness?.state) {
    case "no-credentials":
      return new ZcodeProtocolError(
        `no models available — no zcode credentials found in ~/.zcode/v2/credentials.json. ` +
          `Open the ZCode desktop app once and log in (preferred provider: ${readiness.preferred}; ` +
          `set ZCODE_PROVIDER if you logged in with a different account), then retry.`,
      );
    case "timeout":
      return new ZcodeProtocolError(
        `no models available — the app-server exposed no model within ${readiness.waitedMs}ms of boot ` +
          `(still loading, or the provider refused the account). Retry in a few seconds; ` +
          `if it persists, run zcode_check and verify the account is entitled.`,
      );
    default:
      return new ZcodeProtocolError(
        "no models available — the app-server reported an empty model list. " +
          "If zcode is not logged in, open the ZCode desktop app once and log in; otherwise retry in a few seconds.",
      );
  }
}

export interface ModelChoice {
  model: AvailableModel;
  reasoning: string;
}

/** Pick the model (and default reasoning level) for a turn. Fail-closed on an empty list. */
export function pickModel(models: AvailableModel[], requested?: string, readiness?: ModelsReadiness): ModelChoice {
  if (!models.length) throw noModelsError(readiness);
  const want = (requested?.trim() || process.env.ZCODE_MODEL || "").toLowerCase();
  let model: AvailableModel | undefined;
  if (want) {
    model = models.find(
      (m) =>
        m.modelId.toLowerCase() === want ||
        `${m.providerId}/${m.modelId}`.toLowerCase() === want ||
        (m.label ?? "").toLowerCase() === want,
    );
    if (!model) {
      throw new ZcodeProtocolError(
        `model "${requested}" not available. Available: ${models.map((m) => `${m.providerId}/${m.modelId}`).join(", ")}`,
      );
    }
  } else {
    model = models.find((m) => m.modelId === "GLM-5.3") ?? models[0];
  }
  const reasoning = process.env.ZCODE_REASONING?.trim() || model.reasoning?.defaultLevel || "max";
  return { model, reasoning };
}

/**
 * cwd -> models cache. An empty list is never stored: it is the signature of a
 * snapshot that raced the provider registry, not a fact about the account, and
 * caching it would serve "no models" for the workspace's lifetime.
 */
export class ModelCache {
  private readonly entries = new Map<string, AvailableModel[]>();

  set(cwd: string, models: AvailableModel[]): void {
    if (!models.length) return;
    this.entries.set(cwd, models);
  }

  get(cwd: string): AvailableModel[] | undefined {
    return this.entries.get(cwd);
  }
}

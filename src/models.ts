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
  // Several account providers can expose the same model id (e.g. individual coding plan and
  // start plan both list GLM-5.3): the preferred provider (ZCODE_PROVIDER) wins, any other
  // provider is the fallback when the preferred one exposes nothing suitable.
  const preferred = process.env.ZCODE_PROVIDER?.trim();
  // Start plans are last: the desktop gates them behind an interactive captcha
  // (X-Aliyun-Captcha-Verify-*), so headless requests to them fail authentication.
  const rank = (m: AvailableModel) => (m.providerId === preferred ? 0 : /-start-plan$/.test(m.providerId) ? 2 : 1);
  const ordered = [...models].sort((a, b) => rank(a) - rank(b));
  let model: AvailableModel | undefined;
  if (want) {
    model = ordered.find(
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
    model = ordered.find((m) => m.modelId === "GLM-5.3") ?? ordered[0];
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

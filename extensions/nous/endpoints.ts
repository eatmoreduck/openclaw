export const NOUS_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";

export function isNousInferenceBaseUrl(value: unknown): boolean {
  return typeof value === "string" && value.trim().replace(/\/$/u, "") === NOUS_INFERENCE_BASE_URL;
}

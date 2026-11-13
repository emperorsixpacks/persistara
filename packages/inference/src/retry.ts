/**
 * Free verification steps (attestation, response signature) fetch Intel's quote collateral over the network, which can fail
 * transiently. Retrying them is safe because they only read: the one paid request is never sent again. Only that single
 * retryable condition is retried; every other failure, including a real verification failure, surfaces immediately.
 */
export const COLLATERAL_RETRIES = 4;
const collateralUnavailable = (error: unknown): boolean => {
  const failure = (error as { failure?: { code?: unknown } } | null)?.failure;
  return typeof failure === "object" && failure !== null && failure.code === "quote.collateral_unavailable";
};
export async function retryCollateral<T>(step: () => Promise<T>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = COLLATERAL_RETRIES): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await step(); }
    catch (error) {
      if (attempt >= attempts || !collateralUnavailable(error)) throw error;
      await sleep(1_000 * attempt);
    }
  }
}

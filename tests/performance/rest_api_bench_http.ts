export const restBenchConditionalRequest = (etag: string): RequestInit => ({
  // Native fetch otherwise adds Cache-Control: no-cache for a conditional request,
  // which correctly makes Express return 200 instead of the 304 this scenario measures.
  cache: "no-cache",
  headers: { "If-None-Match": etag },
});

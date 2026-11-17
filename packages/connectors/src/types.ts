import type { Provider } from "@staywall/core";
// Interface from spec §5.0. Shapes are refined per connector in M4+ (no invented API fields).
export interface ConnCtx { connectionId: string; orgId: string; credentials: unknown }
export type ExternalListingInput = { externalId: string; name: string; raw: unknown };
export type RawReview = { raw: unknown };
export type NormalizedReview = { externalReviewId: string; ratingRaw: number; ratingScale: number; body?: string };
export interface Connector {
  provider: Provider;
  validateCredentials(input: unknown): Promise<{ ok: true; meta: Record<string, string> } | { ok: false; error: string }>;
  listListings(ctx: ConnCtx): AsyncIterable<ExternalListingInput>;
  listReviews(ctx: ConnCtx, opts: { since?: Date }): AsyncIterable<RawReview>;
  normalize(raw: RawReview): NormalizedReview | null;
}

import postgres from "postgres";

export type Claims = { sub: string; email?: string; role?: "authenticated" };

/**
 * App-side access pattern (spec §8): each request runs in a transaction as the `authenticated`
 * role with the caller's JWT claims, so RLS applies to every query.
 * `adminDb` (service role) must only be used by Inngest jobs and Stripe webhooks.
 */
export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return {
    sql,
    async withRls<T>(claims: Claims, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true)`;
        await tx`set local role authenticated`;
        return fn(tx as unknown as postgres.TransactionSql);
      }) as Promise<T>;
    },
    end: () => sql.end(),
  };
}

// Owner: Dev C. Sources: gateway().listReputation(), explorerInfo(), txStatus(), receipt(); WS skandha_subscribe ["explorerEvents", seq].
import { DEVNET, todo, type Address, type EntityStatus } from "@altpool/core";

export interface WatchOptions { onStatus: (s: EntityStatus) => void; intervalMs?: number }

/** Returns an unsubscribe function. */
export const watchEntity = (_entity: Address, _opts: WatchOptions): (() => void) => todo("watchEntity");

/** Sends left before throttle / ban: throttled when floor(seen/10) > included + 10, banned when > included + 50. */
export const headroom = (opsSeen: number, opsIncluded: number, r = DEVNET.reputation) => ({
  untilThrottled: Math.max(0, (opsIncluded + r.throttlingSlack + 1) * r.minInclusionDenominator - opsSeen),
  untilBanned: Math.max(0, (opsIncluded + r.banSlack + 1) * r.minInclusionDenominator - opsSeen),
});

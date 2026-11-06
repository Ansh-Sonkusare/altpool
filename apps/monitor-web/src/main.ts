// Owner: Dev C. One entity, live: stake, reputation + headroom, pending, inclusions with VERIFY gas.
import { DEVNET } from "@altpool/core";
import { headroom } from "@altpool/monitor";

const app = document.querySelector("#app")!;
app.textContent = `Altpool monitor · chain ${DEVNET.chainId} · fresh entity throttles in ${headroom(0, 0).untilThrottled} sends`;

// Owner: Dev C. Reset-proof demo script (research repo docs/09). Each step prints an explorer link.
import { todo } from "@altpool/core";

const steps = [
  "fund fresh keys from the faucet",
  "deploy ExitRelay",
  "deposit 0.1 ETH (seed several accounts)",
  "checkAdmission(exit): public ✗, alt ✗ unstaked",
  "stakeEntity(ExitRelay), check again: alt ✓",
  "sendFrameTransaction({ mempool: 'auto' }) -> recipient 0 -> 0.1 − fee",
  "replay the same note -> frame-doctor explains",
];
for (const s of steps) console.log("•", s);
todo("bun run demo");

#!/usr/bin/env tsx
// Owner: Dev B. quietsend deposit | withdraw <note> <recipient>
// Until gate G1 + IP2: MOCK=1 uses mockWithdrawProof() and a placeholder ExitRelay address.
import { todo } from "@altpool/core";

const [cmd] = process.argv.slice(2);
switch (cmd) {
  case "deposit":
    todo("deposit: createNote -> pool.deposit(commitment) with 0.1 ETH -> save note");
    break;
  case "withdraw":
    todo("withdraw: prove -> 2-frame tx (VERIFY ExitRelay, SENDER pool.withdraw), nonce key = nullifier -> sdk.sendFrameTransaction({ precheck: simulator })");
    break;
  default:
    console.error("usage: quietsend deposit | withdraw <note> <recipient>");
    process.exit(2);
}

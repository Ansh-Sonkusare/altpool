// bun src/livePledge/inputs.check.ts
import assert from "node:assert";
import { freshAddress, validate } from "./inputs";

let a = freshAddress();
while (!/[a-f]/i.test(a.slice(2))) a = freshAddress();
const ok = validate({ amount: "10", payee: a, change: a.toLowerCase() });
assert(ok.ok && ok.value.amount === 10_000_000n && ok.value.change === a, "valid input parses, lowercase accepted");

const i = a.slice(2).search(/[a-f]/i) + 2;
const flipped = a.slice(0, i) + (a[i] === a[i]!.toUpperCase() ? a[i]!.toLowerCase() : a[i]!.toUpperCase()) + a.slice(i + 1);
const wrongCase = validate({ amount: "1", payee: flipped, change: a });
assert(!wrongCase.ok && wrongCase.errors.payee, "a flipped checksum letter is refused");

const bad = validate({ amount: "51", payee: "0x123", change: "0x0000000000000000000000000000000000000000" });
assert(!bad.ok && bad.errors.amount && bad.errors.payee && bad.errors.change, "cap, short address and zero address are refused");
assert(!validate({ amount: "0.5", payee: a, change: a }).ok, "under 1 fgUSD refused");
console.log("inputs ok");

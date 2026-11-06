#!/usr/bin/env tsx
// Owner: Dev C. Usage: frame-doctor <rawTx | txHash>
import { todo } from "@altpool/core";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: frame-doctor <rawTx | txHash>");
  process.exit(2);
}
todo("frame-doctor report");

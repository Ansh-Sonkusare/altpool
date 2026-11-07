// CI preset. Add `setupFiles: ["@altpool/simulator/vitest-setup"]` to vitest.config and the altpool matchers are on `expect`.
import { expect } from "vitest";
import { altpoolMatchers } from "./vitest";

expect.extend(altpoolMatchers);

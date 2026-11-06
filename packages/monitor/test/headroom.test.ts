import { expect, it } from "vitest";
import { headroom } from "../src";

it("a fresh entity throttles at its 110th send with 0 included", () => {
  expect(headroom(0, 0).untilThrottled).toBe(110);
  expect(headroom(109, 0).untilThrottled).toBe(1);
  expect(headroom(110, 0).untilThrottled).toBe(0); // floor(110/10)=11 > 0+10
  expect(headroom(0, 0).untilBanned).toBe(510);
});

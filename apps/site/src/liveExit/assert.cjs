// websnark does `const assert = require("assert")`, and Vite would stub that Node builtin with an empty module.
module.exports = function assert(ok, message) {
  if (!ok) throw new Error(message || "assertion failed");
};

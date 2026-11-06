// circomlib's pedersenHash asks blake-hash for blake256 only. The package's public API extends Node's stream.Transform,
// which a browser build does not have, so use its pure-JS engine directly. CommonJS because circomlib require()s it.
const { Buffer } = require("buffer");
const Blake256 = require("blake-hash/lib/blake256");

module.exports = function createBlakeHash(algorithm) {
  if (algorithm !== "blake256") throw new Error(`unsupported hash ${algorithm}`);
  const engine = new Blake256();
  const hash = {
    update(data) {
      engine.update(typeof data === "string" ? Buffer.from(data) : data);
      return hash;
    },
    digest: () => engine.digest(),
  };
  return hash;
};

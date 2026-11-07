# Vendored test contracts

`ViolatingWallet.json` and `Foreign.json` are compiled artifacts of `contracts/src/ViolatingWallet.sol` and
`contracts/src/Foreign.sol` from [forshtat/mempool-workshop](https://github.com/forshtat/mempool-workshop) at commit
`bcfe02a196ca97b6fb0d1044db9d0b4c673831fc`, copied unmodified. Both sources carry `SPDX-License-Identifier: MIT`.

`src/live-suite.ts` deploys them on the devnet: `Foreign` holds a storage slot, and `ViolatingWallet`'s VERIFY frame
reads it, which the alt mempool admits only when the wallet is staked (cases 3 and 4).

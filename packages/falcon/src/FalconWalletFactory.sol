// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FalconWallet} from "./FalconWallet.sol";

/// Deterministic FalconWallet addresses: salt = keccak256 of the NTT-domain key (FalconWallet.pkHash), verifier fixed
/// per factory. The address exists before the wallet does, so a QuietSend exit can pay it while it is still empty
/// space, and anyone can deploy the wallet later (it is bound to the key, so deploying it for someone else is harmless).
contract FalconWalletFactory {
    address public immutable verifier;

    event WalletDeployed(address indexed wallet, bytes32 indexed pkHash);

    constructor(address verifier_) {
        verifier = verifier_;
    }

    function predictAddress(bytes32 pkHash) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(FalconWallet).creationCode, abi.encode(verifier, pkHash)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), pkHash, initCodeHash)))));
    }

    /// Reverts if already deployed (CREATE2 collision). ETH already sitting at the address stays; CREATE2 onto a
    /// funded account is allowed.
    function deploy(bytes32 pkHash) external returns (address wallet) {
        wallet = address(new FalconWallet{salt: pkHash}(verifier, pkHash));
        emit WalletDeployed(wallet, pkHash);
    }
}

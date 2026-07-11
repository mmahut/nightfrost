// This file is part of midnight-indexer.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Vendored and adapted from midnight-indexer (chain-indexer/src/domain/node.rs,
// chain-indexer/src/domain/block.rs and chain-indexer/src/domain/contract_action.rs).

use nightfrost_core::domain::{
    BlockAuthor, BlockHash, ByteVec, ContractAttributes, ContractBalance, ProtocolVersion,
    SerializedContractAddress, SerializedContractState, SerializedTransaction,
    SerializedTransactionIdentifier, SerializedZswapState, TransactionHash, bridge::BridgeEvent,
    dust::DustRegistrationEvent, ledger::ZswapMerkleTreeRoot,
};

/// A block as fetched from the node, wrapping raw (serialized) transactions plus metadata.
#[derive(Debug, Clone)]
pub struct Block {
    pub hash: BlockHash,
    pub height: u64,
    pub protocol_version: ProtocolVersion,
    pub parent_hash: BlockHash,
    pub author: Option<BlockAuthor>,
    pub timestamp: u64,
    pub zswap_merkle_tree_root: ZswapMerkleTreeRoot,
    pub ledger_state_root: Option<ByteVec>,
    pub transactions: Vec<Transaction>,
    pub dust_registration_events: Vec<DustRegistrationEvent>,
    /// c2m-bridge events (5 variants, see nightfrost_core::domain::bridge), decoded from
    /// the node 2.0+ runtime (`subxt_node/runtimes/v2_0_0.rs`); always empty for earlier
    /// runtimes, where the pallet does not exist.
    pub bridge_events: Vec<BridgeEvent>,
}

/// A reference to a block: its hash and height.
#[derive(Debug, Clone, Copy)]
pub struct BlockRef {
    pub hash: BlockHash,
    pub height: u64,
}

impl From<&Block> for BlockRef {
    fn from(block: &Block) -> Self {
        Self {
            hash: block.hash,
            height: block.height,
        }
    }
}

/// A transaction as fetched from the node: regular or system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transaction {
    Regular(RegularTransaction),
    System(SystemTransaction),
}

/// A regular (user-submitted) transaction wrapping its raw bytes plus metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegularTransaction {
    pub hash: TransactionHash,
    pub protocol_version: ProtocolVersion,
    pub raw: SerializedTransaction,
    pub identifiers: Vec<SerializedTransactionIdentifier>,
    pub contract_actions: Vec<ContractAction>,
}

/// A system transaction wrapping its raw bytes plus metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemTransaction {
    pub hash: TransactionHash,
    pub protocol_version: ProtocolVersion,
    pub raw: SerializedTransaction,
}

/// A contract action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractAction {
    pub address: SerializedContractAddress,
    pub state: SerializedContractState,
    pub zswap_state: SerializedZswapState,
    pub extracted_balances: Vec<ContractBalance>,
    pub attributes: ContractAttributes,
}

impl From<nightfrost_core::domain::ContractAction> for ContractAction {
    fn from(contract_action: nightfrost_core::domain::ContractAction) -> Self {
        Self {
            address: contract_action.address,
            state: contract_action.state,
            zswap_state: Default::default(),
            extracted_balances: Default::default(),
            attributes: contract_action.attributes,
        }
    }
}

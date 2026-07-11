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

// Vendored and adapted from midnight-indexer
// (indexer-common/src/domain/ledger/transaction.rs). Wallet-sync trial
// decryption (`relevant`, `can_decrypt_v8`/`can_decrypt_v9`) is dropped.

use crate::{
    domain::{
        ContractAction, ContractAttributes, LedgerVersion, SerializedContractAddress,
        SerializedContractState, SerializedTransactionIdentifier, TransactionHash,
        ledger::{Error, SerializableExt, TransactionV8, TransactionV9},
    },
    ledger_db::FjallLedgerDb,
};
use futures::{StreamExt, TryStreamExt};
use midnight_coin_structure_v2::contract::ContractAddress;
use midnight_coin_structure_v3::contract::ContractAddress as ContractAddressV9;
use midnight_ledger_v8::structure::{
    ContractAction as ContractActionV8, SystemTransaction as LedgerSystemTransactionV8,
};
use midnight_ledger_v9::structure::{
    ContractAction as ContractActionV9, SystemTransaction as LedgerSystemTransactionV9,
};
use midnight_serialize_v1::tagged_deserialize;
use std::error::Error as StdError;

#[derive(Debug, Clone)]
pub enum Transaction {
    V8(TransactionV8<FjallLedgerDb>),
    V9(TransactionV9<FjallLedgerDb>),
}

impl Transaction {
    pub fn deserialize(
        transaction: impl AsRef<[u8]>,
        ledger_version: LedgerVersion,
    ) -> Result<Self, Error> {
        let transaction = match ledger_version {
            LedgerVersion::V8 => {
                let transaction = tagged_deserialize(&mut transaction.as_ref())
                    .map_err(|error| Error::Deserialize("LedgerTransactionV8", error))?;
                Self::V8(transaction)
            }
            LedgerVersion::V9 => {
                let transaction = tagged_deserialize(&mut transaction.as_ref())
                    .map_err(|error| Error::Deserialize("LedgerTransactionV9", error))?;
                Self::V9(transaction)
            }
        };

        Ok(transaction)
    }

    /// Get the hash.
    pub fn hash(&self) -> TransactionHash {
        match self {
            Self::V8(transaction) => transaction.transaction_hash().0.0.into(),
            Self::V9(transaction) => transaction.transaction_hash().0.0.into(),
        }
    }

    /// Get the identifiers.
    pub fn identifiers(&self) -> Result<Vec<SerializedTransactionIdentifier>, Error> {
        match self {
            Self::V8(transaction) => transaction
                .identifiers()
                .map(|identifier| {
                    let identifier = identifier
                        .serialize()
                        .map_err(|error| Error::Serialize("TransactionIdentifierV8", error))?;
                    Ok(identifier)
                })
                .collect(),
            Self::V9(transaction) => transaction
                .identifiers()
                .map(|identifier| {
                    let identifier = identifier
                        .serialize()
                        .map_err(|error| Error::Serialize("TransactionIdentifierV9", error))?;
                    Ok(identifier)
                })
                .collect(),
        }
    }

    /// Get the contract actions; this involves node calls.
    pub async fn contract_actions<E, F>(
        &self,
        get_contract_state: impl Fn(SerializedContractAddress) -> F,
    ) -> Result<Vec<ContractAction>, Error>
    where
        E: StdError + 'static + Send + Sync,
        F: Future<Output = Result<SerializedContractState, E>>,
    {
        match self {
            Self::V8(transaction) => match transaction {
                TransactionV8::Standard(standard_transaction) => {
                    let contract_actions = futures::stream::iter(standard_transaction.actions())
                        .then(|(_, contract_action)| async {
                            match contract_action {
                                ContractActionV8::Deploy(deploy) => {
                                    let address = serialize_contract_address(deploy.address())?;
                                    let state = get_contract_state(address.clone()).await.map_err(
                                        |error| {
                                            Error::GetContractState(address.clone(), error.into())
                                        },
                                    )?;

                                    Ok::<_, Error>(ContractAction {
                                        address,
                                        state,
                                        attributes: ContractAttributes::Deploy,
                                    })
                                }

                                ContractActionV8::Call(call) => {
                                    let address = serialize_contract_address(call.address)?;
                                    let state = get_contract_state(address.clone()).await.map_err(
                                        |error| {
                                            Error::GetContractState(address.clone(), error.into())
                                        },
                                    )?;
                                    let entry_point =
                                        String::from_utf8(call.entry_point.as_ref().to_owned())
                                            .map_err(|error| {
                                                Error::FromUtf8("EntryPointBufV8", error)
                                            })?;

                                    Ok(ContractAction {
                                        address,
                                        state,
                                        attributes: ContractAttributes::Call { entry_point },
                                    })
                                }

                                ContractActionV8::Maintain(update) => {
                                    let address = serialize_contract_address(update.address)?;
                                    let state = get_contract_state(address.clone()).await.map_err(
                                        |error| {
                                            Error::GetContractState(address.clone(), error.into())
                                        },
                                    )?;

                                    Ok(ContractAction {
                                        address,
                                        state,
                                        attributes: ContractAttributes::Update,
                                    })
                                }
                            }
                        })
                        .try_collect::<Vec<_>>()
                        .await?;

                    Ok(contract_actions)
                }

                TransactionV8::ClaimRewards(_) => Ok(vec![]),
            },

            Self::V9(transaction) => match transaction {
                TransactionV9::Standard(standard_transaction) => {
                    let contract_actions = futures::stream::iter(standard_transaction.actions())
                        .then(|(_, contract_action)| async {
                            match contract_action {
                                ContractActionV9::Deploy(deploy) => {
                                    let address = serialize_contract_address_v9(deploy.address())?;
                                    let state = get_contract_state(address.clone()).await.map_err(
                                        |error| {
                                            Error::GetContractState(address.clone(), error.into())
                                        },
                                    )?;

                                    Ok::<_, Error>(ContractAction {
                                        address,
                                        state,
                                        attributes: ContractAttributes::Deploy,
                                    })
                                }

                                ContractActionV9::Call(call) => {
                                    let address = serialize_contract_address_v9(call.address)?;
                                    let state = get_contract_state(address.clone()).await.map_err(
                                        |error| {
                                            Error::GetContractState(address.clone(), error.into())
                                        },
                                    )?;
                                    let entry_point =
                                        String::from_utf8(call.entry_point.as_ref().to_owned())
                                            .map_err(|error| {
                                                Error::FromUtf8("EntryPointBufV9", error)
                                            })?;

                                    Ok(ContractAction {
                                        address,
                                        state,
                                        attributes: ContractAttributes::Call { entry_point },
                                    })
                                }

                                ContractActionV9::Maintain(update) => {
                                    let address = serialize_contract_address_v9(update.address)?;
                                    let state = get_contract_state(address.clone()).await.map_err(
                                        |error| {
                                            Error::GetContractState(address.clone(), error.into())
                                        },
                                    )?;

                                    Ok(ContractAction {
                                        address,
                                        state,
                                        attributes: ContractAttributes::Update,
                                    })
                                }
                            }
                        })
                        .try_collect::<Vec<_>>()
                        .await?;

                    Ok(contract_actions)
                }

                TransactionV9::ClaimRewards(_) => Ok(vec![]),
            },
        }
    }
}

/// Facade for `SystemTransaction` from `midnight_ledger` across supported (protocol) versions.
#[derive(Debug, Clone)]
pub enum SystemTransaction {
    V8(LedgerSystemTransactionV8),
    V9(LedgerSystemTransactionV9),
}

impl SystemTransaction {
    pub fn deserialize(
        transaction: impl AsRef<[u8]>,
        ledger_version: LedgerVersion,
    ) -> Result<Self, Error> {
        let transaction = match ledger_version {
            LedgerVersion::V8 => {
                let transaction = tagged_deserialize(&mut transaction.as_ref())
                    .map_err(|error| Error::Deserialize("LedgerSystemTransactionV8", error))?;
                Self::V8(transaction)
            }
            LedgerVersion::V9 => {
                let transaction = tagged_deserialize(&mut transaction.as_ref())
                    .map_err(|error| Error::Deserialize("LedgerSystemTransactionV9", error))?;
                Self::V9(transaction)
            }
        };

        Ok(transaction)
    }

    /// Get the hash.
    pub fn hash(&self) -> TransactionHash {
        match self {
            Self::V8(transaction) => transaction.transaction_hash().0.0.into(),
            Self::V9(transaction) => transaction.transaction_hash().0.0.into(),
        }
    }
}

fn serialize_contract_address(
    address: ContractAddress,
) -> Result<SerializedContractAddress, Error> {
    address
        .serialize()
        .map_err(|error| Error::Serialize("ContractAddress", error))
}

fn serialize_contract_address_v9(
    address: ContractAddressV9,
) -> Result<SerializedContractAddress, Error> {
    address
        .serialize()
        .map_err(|error| Error::Serialize("ContractAddressV9", error))
}

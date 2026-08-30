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
// (indexer-common/src/domain/ledger/transaction.rs).

use crate::{
    domain::{
        ContractAction, ContractAttributes, LedgerVersion, SerializedContractAddress,
        SerializedContractState, SerializedTransactionIdentifier, TransactionHash,
        ledger::{Error, SerializableExt, TransactionV8, TransactionV9},
    },
    ledger_db::FjallLedgerDb,
};
use futures::{StreamExt, TryStreamExt};
use midnight_coin_structure_v2::{coin::Info, contract::ContractAddress};
use midnight_coin_structure_v3::{
    coin::Info as InfoV9, contract::ContractAddress as ContractAddressV9,
};
use midnight_ledger_v8::structure::{
    ContractAction as ContractActionV8, StandardTransaction as StandardTransactionV8,
    SystemTransaction as LedgerSystemTransactionV8,
};
use midnight_ledger_v9::structure::{
    ContractAction as ContractActionV9, StandardTransaction as StandardTransactionV9,
    SystemTransaction as LedgerSystemTransactionV9,
};
use midnight_serialize_v1::{Deserializable, tagged_deserialize};
use midnight_storage_core_v1::db::DB;
use midnight_transient_crypto_v2::{encryption::SecretKey, proofs::Proof};
use midnight_transient_crypto_v3::{
    encryption::SecretKey as SecretKeyV9, proofs::Proof as ProofV9,
};
use midnight_zswap_v8::Offer as OfferV8;
use midnight_zswap_v9::Offer as OfferV9;
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

    /// Check whether this transaction contains an output decryptable by the
    /// supplied Zswap encryption secret key.
    pub fn relevant(&self, viewing_key: &[u8; 32]) -> bool {
        match self {
            Self::V8(transaction) => match transaction {
                TransactionV8::Standard(StandardTransactionV8 {
                    guaranteed_coins,
                    fallible_coins,
                    ..
                }) => {
                    let secret_key: Option<_> = SecretKey::from_repr(viewing_key).into();
                    let Some(secret_key) = secret_key else {
                        return false;
                    };
                    guaranteed_coins
                        .as_ref()
                        .is_some_and(|offer| can_decrypt_v8(&secret_key, offer))
                        || fallible_coins
                            .values()
                            .any(|offer| can_decrypt_v8(&secret_key, &offer))
                }
                TransactionV8::ClaimRewards(_) => false,
            },
            Self::V9(transaction) => match transaction {
                TransactionV9::Standard(StandardTransactionV9 {
                    guaranteed_coins,
                    fallible_coins,
                    ..
                }) => {
                    let secret_key: Option<_> = SecretKeyV9::from_repr(viewing_key).into();
                    let Some(secret_key) = secret_key else {
                        return false;
                    };
                    guaranteed_coins
                        .as_ref()
                        .is_some_and(|offer| can_decrypt_v9(&secret_key, offer))
                        || fallible_coins
                            .values()
                            .any(|offer| can_decrypt_v9(&secret_key, &offer))
                }
                TransactionV9::ClaimRewards(_) => false,
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

/// Decode either the 32-byte scalar representation used internally or the
/// 33-byte untagged serialization returned by the official wallet WASM SDK.
pub fn viewing_key_repr(serialized: &[u8]) -> Option<[u8; 32]> {
    if let Ok(raw) = <[u8; 32]>::try_from(serialized) {
        return Some(raw);
    }

    let mut input = serialized;
    let key = <SecretKey as Deserializable>::deserialize(&mut input, 0).ok()?;
    if !input.is_empty() {
        return None;
    }
    Some(key.repr())
}

fn can_decrypt_v8<D: DB>(key: &SecretKey, offer: &OfferV8<Proof, D>) -> bool {
    let outputs = offer
        .outputs
        .iter()
        .filter_map(|output| output.ciphertext.clone());
    let transient = offer
        .transient
        .iter()
        .filter_map(|output| output.ciphertext.clone());

    outputs.chain(transient).any(|ciphertext| {
        key.decrypt::<Info>(&(*ciphertext).to_owned().into())
            .is_some()
    })
}

fn can_decrypt_v9<D: DB>(key: &SecretKeyV9, offer: &OfferV9<ProofV9, D>) -> bool {
    let outputs = offer
        .outputs
        .iter()
        .filter_map(|output| output.ciphertext.clone());
    let transient = offer
        .transient
        .iter()
        .filter_map(|output| output.ciphertext.clone());

    outputs.chain(transient).any(|ciphertext| {
        key.decrypt::<InfoV9>(&(*ciphertext).to_owned().into())
            .is_some()
    })
}

#[cfg(test)]
mod viewing_key_tests {
    use super::viewing_key_repr;
    use midnight_serialize_v1::Serializable;
    use midnight_zswap_v8::keys::{SecretKeys, Seed};

    #[test]
    fn accepts_raw_and_wallet_sdk_serialized_keys() {
        let key = SecretKeys::from(Seed::from([7u8; 32])).encryption_secret_key;
        let raw: [u8; 32] = key.repr();
        let mut serialized = Vec::new();
        Serializable::serialize(&key, &mut serialized).unwrap();

        assert_eq!(serialized.len(), 33);
        assert_eq!(viewing_key_repr(&raw), Some(raw));
        assert_eq!(viewing_key_repr(&serialized), Some(raw));
        assert_eq!(viewing_key_repr(&[0u8; 34]), None);
    }
}

// Ledger 9.1 nests the onchain-state arena types deeply enough that the `Send`
// check on the index task overflows the default limit of 128.
#![recursion_limit = "256"]

pub mod domain;
pub mod pipeline;
pub mod subxt_node;

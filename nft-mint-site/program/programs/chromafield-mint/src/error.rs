use anchor_lang::prelude::*;

/// Custom error codes start at 6000 in declaration order.
///
/// The dApp maps these numbers to human-readable copy in
/// `nft-mint-site/src/lib/mint.ts` (`PROGRAM_ERRORS`). Never reorder or reuse a
/// code — append new ones at the end.
#[error_code]
pub enum MintError {
    #[msg("Every token in the collection has been minted.")]
    SoldOut, // 6000

    #[msg("Minting has not opened yet.")]
    MintNotLive, // 6001

    #[msg("The mint window has closed.")]
    MintEnded, // 6002

    #[msg("This wallet is not on the allowlist.")]
    NotAllowlisted, // 6003

    #[msg("The allowlist allocation is exhausted; wait for the public phase.")]
    AllowlistExhausted, // 6004

    #[msg("The payer cannot cover the mint price.")]
    InsufficientPayment, // 6005

    #[msg("Minting is paused by the collection authority.")]
    Paused, // 6006

    #[msg("Per-wallet mint limit reached.")]
    MaxPerWalletExceeded, // 6007

    #[msg("This mint key was already used.")]
    AlreadyMinted, // 6008 (reserved — the `init` constraint on mint_state enforces it)

    #[msg("Only the collection authority may call this instruction.")]
    Unauthorized, // 6009

    #[msg("Unknown phase value.")]
    InvalidPhase, // 6010

    #[msg("Nothing to withdraw beyond the rent floor.")]
    NothingToWithdraw, // 6011
}

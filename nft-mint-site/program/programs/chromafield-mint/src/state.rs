use anchor_lang::prelude::*;

pub const SEED_COLLECTION: &[u8] = b"collection";
pub const SEED_MINT_STATE: &[u8] = b"mint_state";
pub const SEED_WALLET_STATE: &[u8] = b"wallet_state";

pub const PHASE_NOT_STARTED: u8 = 0;
pub const PHASE_ALLOWLIST: u8 = 1;
pub const PHASE_PUBLIC: u8 = 2;
pub const PHASE_ENDED: u8 = 3;

/// Global drop configuration and counters.
///
/// FIELD ORDER IS THE BORSH LAYOUT. The dApp decodes this account by hand in
/// `nft-mint-site/src/lib/program.ts` (`decodeCollection`) — if you add, remove
/// or reorder a field, update the decoder (and its fixture in
/// `nft-mint-site/tests/logic.test.ts`) in the same commit.
#[account]
#[derive(InitSpace)]
pub struct Collection {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub price_lamports: u64,
    pub allowlist_price_lamports: u64,
    pub max_supply: u32,
    pub total_minted: u32,
    pub allowlist_minted: u32,
    pub allowlist_allocation: u32,
    pub max_per_wallet: u32,
    pub royalty_bps: u16,
    pub phase: u8,
    pub paused: bool,
    pub bump: u8,
    pub allowlist_root: [u8; 32],
    pub allowlist_start: i64,
    pub public_start: i64,
    pub ends_at: i64,
    #[max_len(96)]
    pub uri_base: String,
    #[max_len(32)]
    pub name: String,
    #[max_len(16)]
    pub symbol: String,
    #[max_len(16)]
    pub generator_version: String,
}

/// One per minted token, keyed by the mint address so a replayed mint key is
/// rejected by the `init` constraint.
#[account]
pub struct MintState {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub token_index: u32,
    pub phase: u8,
    pub minted_at: i64,
    pub bump: u8,
}

impl MintState {
    pub const LEN: usize = 32 + 32 + 4 + 1 + 8 + 1; // 78
}

/// One per minting wallet — enforces `max_per_wallet` without scanning tokens.
#[account]
pub struct WalletState {
    pub owner: Pubkey,
    pub count: u32,
    pub bump: u8,
}

impl WalletState {
    pub const LEN: usize = 32 + 4 + 1; // 37
}

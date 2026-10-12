//! CHROMAFIELD mint program.
//!
//! One instruction does the whole mint: take payment, create the SPL token mint
//! from a client-supplied keypair, create the receiver's associated token
//! account, mint exactly one unit, drop the mint authority, and write Metaplex
//! Token Metadata (with a zero-supply master edition).
//!
//! ACCOUNT ORDER IS LOAD-BEARING: the dApp builds the instruction by hand in
//! `nft-mint-site/src/lib/mint.ts`. If you reorder the fields of `MintNft`,
//! update `ACCOUNT_ORDER` in `src/lib/program.ts` to match.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, SetAuthority, Token, TokenAccount};
use mpl_token_metadata::instructions::{
    CreateV1, CreateV1Cpi, CreateV1CpiArgs, CreateV1InstructionArgs,
};
use mpl_token_metadata::types::{PrintSupply, TokenStandard};

pub mod error;
pub mod merkle;
pub mod state;

use error::MintError;
use state::{Collection, MintState, WalletState};

declare_id!("35tHJjPucUNrFKyMBm8tgxYzZ8tmhHAMYp6G9mVr5AUj");

#[program]
pub mod chromafield_mint {
    use super::*;

    /// Authority-only. Creates the global Collection account that holds price,
    /// supply, phase, schedule and the allowlist Merkle root.
    pub fn initialize_collection(ctx: Context<InitializeCollection>, args: InitArgs) -> Result<()> {
        let collection = &mut ctx.accounts.collection;
        collection.authority = ctx.accounts.authority.key();
        collection.treasury = args.treasury;
        collection.price_lamports = args.price_lamports;
        collection.allowlist_price_lamports = args.allowlist_price_lamports;
        collection.max_supply = args.max_supply;
        collection.total_minted = 0;
        collection.allowlist_minted = 0;
        collection.allowlist_allocation = args.allowlist_allocation;
        collection.max_per_wallet = args.max_per_wallet;
        collection.royalty_bps = args.royalty_bps;
        collection.phase = state::PHASE_NOT_STARTED;
        collection.paused = false;
        collection.bump = ctx.bumps.collection;
        collection.allowlist_root = args.allowlist_root;
        collection.allowlist_start = args.allowlist_start;
        collection.public_start = args.public_start;
        collection.ends_at = args.ends_at;
        collection.uri_base = args.uri_base;
        collection.name = args.name;
        collection.symbol = args.symbol;
        collection.generator_version = args.generator_version;

        emit!(CollectionInitialized {
            collection: collection.key(),
            max_supply: collection.max_supply,
            allowlist_root: collection.allowlist_root,
        });
        Ok(())
    }

    /// Authority-only. Publishes a new allowlist root (e.g. after a giveaway).
    pub fn set_allowlist_root(ctx: Context<AdminAction>, root: [u8; 32]) -> Result<()> {
        let collection = &mut ctx.accounts.collection;
        collection.allowlist_root = root;
        emit!(AllowlistRootUpdated { collection: collection.key(), root });
        Ok(())
    }

    /// Authority-only. Flips the phase or pauses/unpauses minting.
    pub fn update_phase(ctx: Context<AdminAction>, phase: u8, paused: bool) -> Result<()> {
        require!(phase <= state::PHASE_ENDED, MintError::InvalidPhase);
        let collection = &mut ctx.accounts.collection;
        collection.phase = phase;
        collection.paused = paused;
        emit!(PhaseUpdated { collection: collection.key(), phase, paused });
        Ok(())
    }

    /// Authority-only. Moves the treasury balance to the treasury wallet.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let collection = &ctx.accounts.collection;
        let seeds = &[state::SEED_COLLECTION, &[collection.bump]];
        let signer = &[&seeds[..]];

        let balance = collection.to_account_info().lamports();
        let rent_floor = Rent::get()?.minimum_balance(collection.to_account_info().data_len());
        require!(balance > rent_floor, MintError::NothingToWithdraw);
        let amount = balance - rent_floor;

        **collection.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += amount;

        emit!(Withdrawn { collection: collection.key(), amount });
        Ok(())
    }

    /// The public mint. One token per transaction; batch by sending several.
    pub fn mint_nft(ctx: Context<MintNft>, proof: Vec<[u8; 32]>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        // ---- gates -------------------------------------------------------
        let collection = &ctx.accounts.collection;
        require!(!collection.paused, MintError::Paused);
        require!(now >= collection.allowlist_start, MintError::MintNotLive);
        require!(now < collection.ends_at, MintError::MintEnded);
        require!(
            collection.total_minted < collection.max_supply,
            MintError::SoldOut
        );

        let wallet_state = &mut ctx.accounts.wallet_state;
        require!(
            wallet_state.count < collection.max_per_wallet,
            MintError::MaxPerWalletExceeded
        );

        // ---- price + allowlist ------------------------------------------
        let in_allowlist_window = now < collection.public_start;
        let price_lamports = if in_allowlist_window {
            require!(
                collection.allowlist_minted < collection.allowlist_allocation,
                MintError::AllowlistExhausted
            );
            let leaf = merkle::leaf(&ctx.accounts.receiver.key());
            require!(
                merkle::verify(&leaf, &proof, collection.allowlist_root),
                MintError::NotAllowlisted
            );
            collection.allowlist_price_lamports
        } else {
            collection.price_lamports
        };

        // ---- payment -----------------------------------------------------
        let rent = Rent::get()?;
        let mint_space = 82; // SPL token mint, no extensions
        let required = price_lamports
            .checked_add(rent.minimum_balance(mint_space))
            .ok_or(MintError::InsufficientPayment)?;
        require!(
            ctx.accounts.payer.lamports() >= required,
            MintError::InsufficientPayment
        );

        if price_lamports > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                price_lamports,
            )?;
        }

        // ---- token mint --------------------------------------------------
        // The mint keypair is generated client-side and signs the transaction,
        // so the program can create the account and hand authority to the PDA.
        let collection_info = ctx.accounts.collection.to_account_info();
        let collection_bump = ctx.accounts.collection.bump;
        let collection_seeds = &[state::SEED_COLLECTION, &[collection_bump]];
        let collection_signer = &[&collection_seeds[..]];

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.mint.to_account_info(),
                },
                collection_signer,
            ),
            rent.minimum_balance(mint_space),
            mint_space as u64,
            &token::ID,
        )?;

        token::initialize_mint2(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::InitializeMint2 {
                    mint: ctx.accounts.mint.to_account_info(),
                },
                collection_signer,
            ),
            0, // decimals — an NFT is indivisible
            &ctx.accounts.collection.key(),
            Some(&ctx.accounts.collection.key()),
        )?;

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.receiver_token_account.to_account_info(),
                    authority: collection_info.clone(),
                },
                collection_signer,
            ),
            1,
        )?;

        // Drop mint authority so exactly one unit can ever exist.
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                    current_authority: collection_info.clone(),
                },
                collection_signer,
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        // ---- metadata ----------------------------------------------------
        let collection = &mut ctx.accounts.collection;
        let token_index = collection.total_minted.checked_add(1).unwrap();
        let name = format!("{} #{}", collection.name, token_index);
        let uri = format!("{}{}.json", collection.uri_base, token_index);
        let symbol = collection.symbol.clone();
        let royalty_bps = collection.royalty_bps;

        let creators = Some(vec![mpl_token_metadata::types::Creator {
            address: collection.authority,
            verified: false,
            share: 100,
        }]);

        CreateV1Cpi::new(
            &ctx.accounts.metadata_program.to_account_info(),
            CreateV1CpiArgs {
                metadata: ctx.accounts.metadata.to_account_info(),
                master_edition: ctx.accounts.master_edition.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: collection_info.clone(),
                authority_pda: collection_info.clone(),
                payer: ctx.accounts.payer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                sysvar_instructions: ctx.accounts.sysvar_instructions.to_account_info(),
                spl_token_program: Some(ctx.accounts.token_program.to_account_info()),
                authorization_rules_program: None,
                authorization_rules: None,
            },
            CreateV1InstructionArgs {
                name,
                symbol,
                uri,
                seller_fee_basis_points: royalty_bps,
                creators,
                collection: None,
                uses: None,
                primary_sale_happened: true,
                is_mutable: false,
                token_standard: Some(TokenStandard::NonFungible),
                collection_details: None,
                rule_set: None,
                print_supply: Some(PrintSupply::Zero),
            },
        )
        .invoke_signed(collection_signer)?;

        // ---- bookkeeping -------------------------------------------------
        let mint_state = &mut ctx.accounts.mint_state;
        mint_state.mint = ctx.accounts.mint.key();
        mint_state.owner = ctx.accounts.receiver.key();
        mint_state.token_index = token_index;
        mint_state.phase = if in_allowlist_window {
            state::PHASE_ALLOWLIST
        } else {
            state::PHASE_PUBLIC
        };
        mint_state.minted_at = now;
        mint_state.bump = ctx.bumps.mint_state;

        wallet_state.owner = ctx.accounts.receiver.key();
        wallet_state.count = wallet_state.count.checked_add(1).unwrap();
        wallet_state.bump = ctx.bumps.wallet_state;

        collection.total_minted = token_index;
        if in_allowlist_window {
            collection.allowlist_minted = collection.allowlist_minted.checked_add(1).unwrap();
        }
        if collection.total_minted >= collection.max_supply {
            collection.phase = state::PHASE_ENDED;
        }

        emit!(NftMinted {
            collection: collection.key(),
            mint: mint_state.mint,
            owner: mint_state.owner,
            token_index,
            price_lamports,
            phase: mint_state.phase,
        });
        Ok(())
    }
}

/* ------------------------------------------------------------------ args */

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitArgs {
    pub treasury: Pubkey,
    pub price_lamports: u64,
    pub allowlist_price_lamports: u64,
    pub max_supply: u32,
    pub allowlist_allocation: u32,
    pub max_per_wallet: u32,
    pub royalty_bps: u16,
    pub allowlist_root: [u8; 32],
    pub allowlist_start: i64,
    pub public_start: i64,
    pub ends_at: i64,
    pub uri_base: String,
    pub name: String,
    pub symbol: String,
    pub generator_version: String,
}

/* -------------------------------------------------------------- accounts */

#[derive(Accounts)]
pub struct InitializeCollection<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Collection::INIT_SPACE,
        seeds = [state::SEED_COLLECTION],
        bump,
    )]
    pub collection: Account<'info, Collection>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [state::SEED_COLLECTION],
        bump = collection.bump,
        has_one = authority @ MintError::Unauthorized,
    )]
    pub collection: Account<'info, Collection>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [state::SEED_COLLECTION],
        bump = collection.bump,
        has_one = authority @ MintError::Unauthorized,
    )]
    pub collection: Account<'info, Collection>,

    /// CHECK: matches the treasury recorded on the Collection account.
    #[account(mut, address = collection.treasury @ MintError::Unauthorized)]
    pub treasury: AccountInfo<'info>,
}

/// Account order for `mint_nft` — keep in sync with the dApp.
#[derive(Accounts)]
pub struct MintNft<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [state::SEED_COLLECTION],
        bump = collection.bump,
    )]
    pub collection: Account<'info, Collection>,

    #[account(
        init,
        payer = payer,
        space = 8 + MintState::LEN,
        seeds = [state::SEED_MINT_STATE, mint.key().as_ref()],
        bump,
    )]
    pub mint_state: Account<'info, MintState>,

    /// Fresh keypair generated by the client; signs the transaction.
    #[account(mut)]
    pub mint: Signer<'info>,

    /// CHECK: created and written by the Metaplex CPI.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: created and written by the Metaplex CPI.
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = receiver,
        token_program = token_program,
    )]
    pub receiver_token_account: Account<'info, TokenAccount>,

    /// CHECK: the wallet that will own the NFT; validated against the allowlist leaf.
    pub receiver: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + WalletState::LEN,
        seeds = [state::SEED_WALLET_STATE, receiver.key().as_ref()],
        bump,
    )]
    pub wallet_state: Account<'info, WalletState>,

    /// CHECK: matches the treasury recorded on the Collection account.
    #[account(mut, address = collection.treasury @ MintError::Unauthorized)]
    pub treasury: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Metaplex Token Metadata program, address-checked by the CPI.
    pub metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: instructions sysvar, required by Metaplex CreateV1.
    pub sysvar_instructions: UncheckedAccount<'info>,
}

/* ---------------------------------------------------------------- events */

#[event]
pub struct NftMinted {
    pub collection: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub token_index: u32,
    pub price_lamports: u64,
    pub phase: u8,
}

#[event]
pub struct CollectionInitialized {
    pub collection: Pubkey,
    pub max_supply: u32,
    pub allowlist_root: [u8; 32],
}

#[event]
pub struct AllowlistRootUpdated {
    pub collection: Pubkey,
    pub root: [u8; 32],
}

#[event]
pub struct PhaseUpdated {
    pub collection: Pubkey,
    pub phase: u8,
    pub paused: bool,
}

#[event]
pub struct Withdrawn {
    pub collection: Pubkey,
    pub amount: u64,
}

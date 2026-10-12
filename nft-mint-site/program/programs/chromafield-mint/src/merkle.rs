//! Merkle verification for the allowlist.
//!
//! Must stay byte-for-byte compatible with `nft-mint-site/src/lib/merkle.ts`:
//!   • leaf  = keccak256(pubkey_bytes)
//!   • inner = keccak256(min(a, b) || max(a, b))  (lexicographic byte compare)
//!
//! The sorted-pair scheme makes proofs order-independent, which is what the
//! TypeScript tree builder produces.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

pub fn leaf(address: &Pubkey) -> [u8; 32] {
    keccak::hashv(&[address.as_ref()]).to_bytes()
}

fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    keccak::hashv(&[&first[..], &second[..]]).to_bytes()
}

pub fn verify(leaf: &[u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    let mut computed = *leaf;
    for step in proof {
        computed = hash_pair(&computed, step);
    }
    // Constant-time-ish comparison; the root is public so this is not a secret.
    computed == root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn single_leaf_tree_verifies_with_empty_proof() {
        let l = leaf(&addr(1));
        assert!(verify(&l, &[], l));
    }

    #[test]
    fn two_leaf_tree_is_order_independent() {
        let a = leaf(&addr(1));
        let b = leaf(&addr(2));
        let root = hash_pair(&a, &b);
        assert!(verify(&a, &[b], root));
        assert!(verify(&b, &[a], root));
    }

    #[test]
    fn wrong_leaf_fails() {
        let a = leaf(&addr(1));
        let b = leaf(&addr(2));
        let root = hash_pair(&a, &b);
        assert!(!verify(&leaf(&addr(3)), &[b], root));
    }
}

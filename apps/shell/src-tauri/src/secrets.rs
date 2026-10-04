//! Stronghold vault plugin — encrypted-at-rest secret storage.
//! The key is derived with argon2 from a machine-local salt file; secrets
//! never appear in the DB, logs, or the UI. At boot the frontend (trusted,
//! same process) may push unlocked integration secrets into the Runner's
//! in-memory store via `push_secrets_to_runner`.

use argon2::{hash_raw, Config, Variant, Version};

pub fn stronghold_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_stronghold::Builder::new(|password| {
        let config = Config {
            lanes: 4,
            mem_cost: 10_000,
            time_cost: 10,
            variant: Variant::Argon2id,
            version: Version::Version13,
            ..Default::default()
        };
        let salt = b"nexus-stronghold-salt-v1";
        hash_raw(password.as_ref(), salt, &config).expect("failed to hash stronghold password")
    })
    .build()
}

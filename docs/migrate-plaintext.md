# Migrating a pre-M10 plaintext database

M10 encrypts the database at rest (whole-file, SQLCipher-style via the
`better-sqlite3-multiple-ciphers` alias). A database created by a pre-M10
build is **plaintext**, and live mode **refuses to open it** rather than
silently re-encrypt or downgrade:

```
plaintext Partner database detected at <path> — M10 requires encryption at
rest. Export your data or remove the file to start fresh (see docs for the
migration path).
```

## Why not auto-migrate?

Silent re-encryption of a whole DB at first boot is a one-way operation with
no clean rollback, and alpha DBs are small. Export → fresh start is safer
and loss-free for the supported stores.

## The migration path (alpha)

1. **Export what you want to keep from the OLD (plaintext) core first.** Run
   the old build once against the plaintext DB (git checkout the pre-M10
   `core/package.json` if needed — or open the file with plain
   `better-sqlite3` in a scratch script via `openDatabase()`), and use the
   app's export surfaces:
   - Notes: Notes view → **Export notes** (markdown files on disk).
   - Conversations/messages: chat transcript copy (or leave — chat history
     is the least-structured store).
   - Profile/memory, personas, providers: re-enter manually (provider keys
     live in the OS keychain already — re-add the profile pointing at the
     same keychain account).
2. **Remove the old plaintext DB file** (and its `-wal`/`-shm` sidecars).
3. **Boot the new core** in live mode — a fresh encrypted database is
   created and keyed automatically (`partner`/`db-key` in the OS keychain).
4. Re-import the exported notes/personas/providers.

Prefer to keep everything? Store the plaintext file somewhere safe as a
backup and keep the old core binary around — nothing is deleted by Partner.

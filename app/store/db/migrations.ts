import Database from 'better-sqlite3';
import logger from '../../log';

const log = logger.child({ component: 'store-migrations' });

export interface Migration {
    id: number;
    name: string;
    sql: string[];
    /** Tables this migration guarantees. Verified by `verifySchema()` after the run. */
    creates?: string[];
}

/**
 * Fork-owned migrations must not reuse upstream's small sequential ids.
 *
 * Upstream adds one id at a time (0, 1, 2, ...) and `id` is the PRIMARY KEY of
 * `__wud_migrations`, so a fork migration parked on the next upstream id is
 * guaranteed to collide: upstream's insert would fail on the primary key and
 * `runMigrations()` would throw, stopping the app from booting at all.
 * Fork migrations therefore live at 9000+ so the two id spaces cannot meet.
 */
export const FORK_MIGRATION_ID_BASE = 9000;

/**
 * Rows written by earlier fork builds that reused an upstream id. They are moved
 * out of upstream's id range on startup, matched by **name** (the stable
 * identity) and never by the bare id. Idempotent: once moved, the lookup finds
 * nothing to do.
 */
const LEGACY_ID_RENUMBERING: {
    fromId: number;
    fromName: string;
    toId: number;
    toName: string;
}[] = [
    {
        fromId: 5,
        fromName: '0005_watched_containers',
        toId: 9005,
        toName: '9005_watched_containers',
    },
];

export const migrations: Migration[] = [
    {
        id: 0,
        name: '0000_initial',
        creates: [
            'app_info',
            'containers',
            'container_images',
            'container_results_history',
            'sessions',
            'wud_configurations',
        ],
        sql: [
            `CREATE TABLE IF NOT EXISTS app_info (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                name TEXT DEFAULT 'wud' NOT NULL,
                version TEXT NOT NULL,
                updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
            );`,
            `CREATE TABLE IF NOT EXISTS containers (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                display_icon TEXT DEFAULT 'mdi:docker' NOT NULL,
                status TEXT DEFAULT 'unknown' NOT NULL,
                watcher TEXT NOT NULL,
                include_tags TEXT,
                exclude_tags TEXT,
                transform_tags TEXT,
                link_template TEXT,
                link TEXT,
                trigger_include TEXT,
                trigger_exclude TEXT,
                labels TEXT,
                created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
            );`,
            `CREATE TABLE IF NOT EXISTS container_images (
                container_id TEXT PRIMARY KEY NOT NULL,
                image_id TEXT NOT NULL,
                registry_name TEXT NOT NULL,
                registry_url TEXT NOT NULL,
                name TEXT NOT NULL,
                tag_value TEXT NOT NULL,
                tag_semver INTEGER DEFAULT 0 NOT NULL,
                digest_watch INTEGER DEFAULT 0 NOT NULL,
                digest_value TEXT,
                digest_repo TEXT,
                architecture TEXT NOT NULL,
                os TEXT NOT NULL,
                variant TEXT,
                created TEXT,
                FOREIGN KEY (container_id) REFERENCES containers(id) ON UPDATE NO ACTION ON DELETE CASCADE
            );`,
            `CREATE TABLE IF NOT EXISTS container_results_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                container_id TEXT NOT NULL,
                tag TEXT,
                digest TEXT,
                created TEXT,
                link TEXT,
                update_available INTEGER DEFAULT 0 NOT NULL,
                update_kind TEXT,
                local_value TEXT,
                remote_value TEXT,
                semver_diff TEXT,
                error_message TEXT,
                checked_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                FOREIGN KEY (container_id) REFERENCES containers(id) ON UPDATE NO ACTION ON DELETE CASCADE
            );`,
            `CREATE INDEX IF NOT EXISTS idx_results_history_container ON container_results_history (container_id);`,
            `CREATE INDEX IF NOT EXISTS idx_results_history_checked_at ON container_results_history (checked_at);`,
            `CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY NOT NULL,
                content TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                expires_at INTEGER
            );`,
            `CREATE TABLE IF NOT EXISTS wud_configurations (
                id TEXT PRIMARY KEY NOT NULL,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                config TEXT NOT NULL,
                enabled INTEGER DEFAULT 1 NOT NULL,
                created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
            );`,
        ],
    },
    {
        id: 1,
        name: '0001_users_and_tokens',
        creates: ['users', 'api_tokens'],
        sql: [
            `CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY NOT NULL,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT,
                provider TEXT DEFAULT 'local' NOT NULL,
                role TEXT DEFAULT 'ro' NOT NULL,
                preferences TEXT,
                created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
            );`,
            `CREATE TABLE IF NOT EXISTS api_tokens (
                id TEXT PRIMARY KEY NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                scopes TEXT NOT NULL,
                expires_at INTEGER,
                created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                last_used_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE NO ACTION ON DELETE CASCADE
            );`,
            `CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);`,
            `CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash);`,
        ],
    },
    {
        id: 2,
        name: '0002_container_stack',
        sql: [
            `ALTER TABLE containers ADD COLUMN stack TEXT;`,
            `CREATE INDEX IF NOT EXISTS idx_containers_stack ON containers (stack);`,
        ],
    },
    {
        id: 3,
        name: '0003_container_snooze',
        sql: [
            `ALTER TABLE containers ADD COLUMN snoozed_version TEXT;`,
            `ALTER TABLE containers ADD COLUMN snoozed_until INTEGER;`,
        ],
    },
    {
        id: 4,
        name: '0004_container_delay',
        sql: [`ALTER TABLE containers ADD COLUMN delay TEXT;`],
    },
    {
        // Fork-owned migration. Parked at 9005 (not 5) so it can never occupy an
        // id upstream is about to use; see FORK_MIGRATION_ID_BASE above.
        id: 9005,
        name: '9005_watched_containers',
        creates: ['watched_containers'],
        sql: [
            `CREATE TABLE IF NOT EXISTS watched_containers (
                watcher TEXT NOT NULL,
                name TEXT NOT NULL,
                watched INTEGER DEFAULT 1 NOT NULL,
                updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
                PRIMARY KEY (watcher, name)
            );`,
        ],
    },
];

/**
 * Move rows written by older fork builds out of upstream's id range.
 *
 * Matched by name, so it is a no-op on fresh databases and on databases that
 * have already been renumbered. Runs before the applied-set is read.
 */
function renumberLegacyForkMigrations(sqlite: Database.Database) {
    for (const entry of LEGACY_ID_RENUMBERING) {
        const row = sqlite
            .prepare('SELECT id, name FROM __wud_migrations WHERE id = ?')
            .get(entry.fromId) as { id: number; name: string } | undefined;
        if (!row) {
            continue;
        }
        if (row.name !== entry.fromName) {
            // Some other migration is already sitting on that id. Leave it alone;
            // that is upstream's row, not ours.
            log.warn(
                `Migration id ${entry.fromId} holds "${row.name}", not the legacy fork migration "${entry.fromName}"; leaving it untouched`,
            );
            continue;
        }
        log.info(
            `Renumbering legacy fork migration "${entry.fromName}" from id ${entry.fromId} to id ${entry.toId}`,
        );
        const occupied = sqlite
            .prepare('SELECT name FROM __wud_migrations WHERE id = ?')
            .get(entry.toId) as { name: string } | undefined;
        if (occupied) {
            // The target id already records this same migration, so the legacy
            // row is a stale duplicate: drop it instead of colliding.
            log.warn(
                `Migration id ${entry.toId} already holds "${occupied.name}"; dropping the stale duplicate row at id ${entry.fromId}`,
            );
            sqlite
                .prepare('DELETE FROM __wud_migrations WHERE id = ?')
                .run(entry.fromId);
            continue;
        }
        sqlite
            .prepare(
                'UPDATE __wud_migrations SET id = ?, name = ? WHERE id = ?',
            )
            .run(entry.toId, entry.toName, entry.fromId);
    }
}

/**
 * Fail loudly if the schema a migration promises is missing.
 *
 * Without this a skipped migration shows up much later as an opaque SQL error
 * from whichever query happens to touch the missing table first.
 */
function verifySchema(sqlite: Database.Database) {
    const present = new Set(
        (
            sqlite
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as { name: string }[]
        ).map((row) => row.name),
    );
    const missing: string[] = [];
    for (const migration of migrations) {
        for (const table of migration.creates ?? []) {
            if (!present.has(table)) {
                missing.push(`${table} (from ${migration.name})`);
            }
        }
    }
    if (missing.length > 0) {
        throw new Error(
            `Schema verification failed, missing table(s): ${missing.join(', ')}`,
        );
    }
}

/**
 * A migration is considered applied only if the journal says so AND every table
 * it promises actually exists.
 *
 * The journal alone is not enough: rows can outlive their tables (a dropped
 * table, a partially-restored backup), and treating those as "applied" would
 * skip the migration forever and leave the app running on a broken schema.
 * Table-creating migrations are written as `CREATE TABLE IF NOT EXISTS`, so
 * re-running one that is already in place is harmless.
 */
function isApplied(
    migration: Migration,
    appliedNames: Set<string>,
    presentTables: Set<string>,
): boolean {
    if (!appliedNames.has(migration.name)) {
        return false;
    }
    for (const table of migration.creates ?? []) {
        if (!presentTables.has(table)) {
            log.warn(
                `Migration "${migration.name}" is recorded as applied but table "${table}" is missing; re-running it to restore the schema`,
            );
            return false;
        }
    }
    return true;
}

function existingTables(sqlite: Database.Database): Set<string> {
    return new Set(
        (
            sqlite
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as { name: string }[]
        ).map((row) => row.name),
    );
}

export function runMigrations(sqlite: Database.Database) {
    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS __wud_migrations (
            id INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            applied_at TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL
        );
    `);

    renumberLegacyForkMigrations(sqlite);

    // Identity is the migration *name*, not the numeric id. Upstream owns the
    // small id space and may reuse an id we already wrote; keying on the id
    // would then skip upstream's migration forever. Names are stable and unique.
    const appliedRows = sqlite
        .prepare('SELECT name FROM __wud_migrations')
        .all() as { name: string }[];
    const appliedNames = new Set(appliedRows.map((row) => row.name));
    let presentTables = existingTables(sqlite);

    for (const migration of migrations) {
        if (!isApplied(migration, appliedNames, presentTables)) {
            const alreadyRecorded = appliedNames.has(migration.name);
            log.info(
                `Applying DDL migration ${migration.id} (${migration.name})`,
            );
            sqlite.transaction(() => {
                // Every statement is guarded (IF NOT EXISTS / column checks), so
                // re-running a migration whose table vanished restores it without
                // disturbing existing data.
                for (const query of migration.sql) {
                    sqlite.exec(query);
                }
                if (alreadyRecorded) {
                    // The name is the identity and it is already in the journal;
                    // only the table was missing. Nothing to record.
                    return;
                }
                const holder = sqlite
                    .prepare('SELECT name FROM __wud_migrations WHERE id = ?')
                    .get(migration.id) as { name: string } | undefined;
                if (holder) {
                    // Never overwrite a foreign row. The schema is what matters,
                    // and verifySchema() below confirms it.
                    log.error(
                        `Cannot record migration "${migration.name}": id ${migration.id} is held by "${holder.name}"`,
                    );
                    return;
                }
                sqlite
                    .prepare(
                        'INSERT INTO __wud_migrations (id, name) VALUES (?, ?)',
                    )
                    .run(migration.id, migration.name);
            })();
            appliedNames.add(migration.name);
            presentTables = existingTables(sqlite);
        }
    }

    verifySchema(sqlite);
}

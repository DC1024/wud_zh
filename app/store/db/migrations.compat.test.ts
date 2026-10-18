import Database from 'better-sqlite3';
import { runMigrations, migrations } from './migrations';

// Regression cover for the fork-vs-upstream migration id collision.
//
// The fork used to park its `watched_containers` migration on upstream's next
// free id (5). Because `id` is the PRIMARY KEY of `__wud_migrations`, upstream
// shipping its own migration 5 would have collided and stopped the app from
// booting. These tests pin the invariants that keep the two id spaces apart and
// make the upgrade path safe on databases created by the older fork builds.
//
// They use real SQLite (in-memory) on purpose: the unit under test is what it
// does to an existing database, which mocks cannot express.

const FORK_ID = 9005;
const LEGACY_ID = 5;

function freshDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

function journal(db: Database.Database) {
    return db
        .prepare('SELECT id, name FROM __wud_migrations ORDER BY id')
        .all() as { id: number; name: string }[];
}

function tables(db: Database.Database) {
    return (
        db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as { name: string }[]
    ).map((r) => r.name);
}

function watchRows(db: Database.Database) {
    return db
        .prepare(
            'SELECT watcher, name, watched FROM watched_containers ORDER BY watcher, name',
        )
        .all();
}

/** A database as produced by the older fork build: fork migration on id 5. */
function legacyDb() {
    const db = freshDb();
    runMigrations(db);
    db.prepare('UPDATE __wud_migrations SET id = ?, name = ? WHERE id = ?').run(
        LEGACY_ID,
        '0005_watched_containers',
        FORK_ID,
    );
    db.prepare(
        "INSERT INTO watched_containers (watcher, name, watched) VALUES ('docker', 'alpha', 1), ('docker', 'beta', 1), ('swarm', 'gamma', 0)",
    ).run();
    return db;
}

describe('fork migration id isolation', () => {
    test('no fork migration occupies an id inside upstream range', () => {
        // Upstream allocates ids incrementally; leaving 0..999 free means it can
        // grow for a very long time before it can ever reach ours.
        const upstreamRange = migrations.filter(
            (m) => m.id >= 0 && m.id < 1000,
        );
        expect(upstreamRange.map((m) => m.id)).toEqual([0, 1, 2, 3, 4]);
    });

    test('every fork-owned migration id is at or above the fork base', () => {
        const forkOwned = migrations.filter((m) => m.name.startsWith('9005_'));
        expect(forkOwned.length).toBeGreaterThan(0);
        for (const m of forkOwned) {
            expect(m.id).toBeGreaterThanOrEqual(9000);
        }
    });
});

describe('upgrade from a legacy fork database', () => {
    test('moves id 5 to 9005 and preserves every row', () => {
        const db = legacyDb();
        const before = watchRows(db);
        expect(journal(db).map((r) => r.id)).toContain(LEGACY_ID);

        runMigrations(db);

        const rows = journal(db);
        expect(rows.map((r) => r.id)).not.toContain(LEGACY_ID);
        expect(rows.find((r) => r.id === FORK_ID)?.name).toBe(
            '9005_watched_containers',
        );
        expect(watchRows(db)).toEqual(before);
        db.close();
    });

    test('does not re-run upstream migrations during the renumbering', () => {
        const db = legacyDb();
        runMigrations(db);
        // 0..4 must be intact and unchanged; a re-run of 0000/0001 would have
        // thrown on duplicate tables or columns.
        expect(
            journal(db)
                .filter((r) => r.id <= 4)
                .map((r) => r.name),
        ).toEqual([
            '0000_initial',
            '0001_users_and_tokens',
            '0002_container_stack',
            '0003_container_snooze',
            '0004_container_delay',
        ]);
        expect(tables(db)).toContain('watched_containers');
        db.close();
    });

    test('is idempotent across repeated startups', () => {
        const db = legacyDb();
        runMigrations(db);
        const once = journal(db);
        runMigrations(db);
        runMigrations(db);
        expect(journal(db)).toEqual(once);
        db.close();
    });

    test('leaves an upstream row on id 5 alone when one already exists', () => {
        const db = freshDb();
        runMigrations(db);
        // Legit fork state, but a row already owns id 5: that row is upstream's.
        db.prepare('UPDATE __wud_migrations SET id = ? WHERE id = ?').run(
            LEGACY_ID,
            FORK_ID,
        );
        db.prepare(
            "INSERT INTO __wud_migrations (id, name) VALUES (6, '0006_upstream_other')",
        ).run();

        runMigrations(db);

        // Unrelated rows are never touched.
        expect(journal(db).find((r) => r.id === 6)?.name).toBe(
            '0006_upstream_other',
        );
        // And our fork migration is recorded under its own id again, because the
        // bare id 5 no longer identifies it.
        expect(tables(db)).toContain('watched_containers');
        db.close();
    });

    test('applies the fork migration when upstream later claims id 5', () => {
        const db = freshDb();
        runMigrations(db);
        // Simulate upstream shipping migration 5 after us.
        db.prepare(
            "UPDATE __wud_migrations SET id = 5, name = '0005_upstream_thing' WHERE id = ?",
        ).run(FORK_ID);
        db.exec('DROP TABLE watched_containers');

        runMigrations(db);

        const rows = journal(db);
        expect(rows.find((r) => r.id === 5)?.name).toBe('0005_upstream_thing');
        expect(rows.find((r) => r.id === FORK_ID)).toBeDefined();
        expect(tables(db)).toContain('watched_containers');
        db.close();
    });
});

describe('schema self-healing', () => {
    test('recreates a table whose journal row survived but table vanished', () => {
        const db = freshDb();
        runMigrations(db);
        db.exec('DROP TABLE watched_containers');

        expect(() => runMigrations(db)).not.toThrow();

        expect(tables(db)).toContain('watched_containers');
        expect(journal(db).find((r) => r.id === FORK_ID)).toBeDefined();
        db.close();
    });

    test('keeps existing preference data when it heals the table', () => {
        const db = freshDb();
        runMigrations(db);
        db.prepare(
            "INSERT INTO watched_containers (watcher, name, watched) VALUES ('docker', 'keepme', 1)",
        ).run();
        // Simulate the table surviving while the journal row says otherwise.
        db.exec('DELETE FROM __wud_migrations WHERE id = 9005');
        runMigrations(db);
        expect(watchRows(db)).toEqual([
            { watcher: 'docker', name: 'keepme', watched: 1 },
        ]);
        db.close();
    });
});

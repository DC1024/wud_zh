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
    // Roll back to a pre-9.8.0 layout: upstream's id-5 migration (version
    // columns) did not exist yet, so drop it from the journal and schema, then
    // put the fork migration back on id 5 (its historical colliding location).
    db.exec('ALTER TABLE container_images DROP COLUMN version');
    db.exec('ALTER TABLE container_results_history DROP COLUMN version');
    db.prepare('DELETE FROM __wud_migrations WHERE id = ?').run(LEGACY_ID);
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
        expect(upstreamRange.map((m) => m.id)).toEqual([0, 1, 2, 3, 4, 5]);
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
        // The freed id 5 is immediately claimed by upstream's own migration;
        // the fork row itself must now live under 9005.
        expect(rows.find((r) => r.id === LEGACY_ID)?.name).toBe(
            '0005_image_and_result_version',
        );
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
        // Upstream owns id 5 out of the box now; add an unrelated higher row too.
        db.prepare(
            "INSERT INTO __wud_migrations (id, name) VALUES (6, '0006_upstream_other')",
        ).run();

        runMigrations(db);

        const rows = journal(db);
        // Upstream's id-5 row is never hijacked by the fork renumbering.
        expect(rows.find((r) => r.id === LEGACY_ID)?.name).toBe(
            '0005_image_and_result_version',
        );
        // Unrelated rows are never touched.
        expect(rows.find((r) => r.id === 6)?.name).toBe('0006_upstream_other');
        // Our fork migration lives under its own id.
        expect(rows.find((r) => r.id === FORK_ID)?.name).toBe(
            '9005_watched_containers',
        );
        expect(tables(db)).toContain('watched_containers');
        db.close();
    });

    test('applies the fork migration when upstream claims id 5', () => {
        const db = freshDb();
        runMigrations(db);
        // Upstream already ships its own migration 5; drop the fork table so we
        // can observe the fork migration (re)creating it instead of being
        // skipped because the bare id 5 now means upstream's row.
        db.exec('DROP TABLE watched_containers');

        runMigrations(db);

        const rows = journal(db);
        expect(rows.find((r) => r.id === 5)?.name).toBe(
            '0005_image_and_result_version',
        );
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

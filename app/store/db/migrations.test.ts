import Database from 'better-sqlite3';
import { runMigrations, migrations } from './migrations';

// These tests exercise real SQLite (in-memory), not mocks: the whole point of
// this module is what it does to an existing database, so fake objects would
// not prove anything.

function freshDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

/** The database as an older fork build left it: fork migration on id 5. */
function legacyForkDb() {
    const db = freshDb();
    // Bring the schema up with the *new* code first, then roll back to the
    // pre-9.8.0 layout: upstream's id-5 migration (version columns) did not
    // exist yet, so remove it before putting the fork migration back on id 5.
    runMigrations(db);
    db.exec('ALTER TABLE container_images DROP COLUMN version');
    db.exec('ALTER TABLE container_results_history DROP COLUMN version');
    db.prepare('DELETE FROM __wud_migrations WHERE id = 5').run();
    db.prepare(
        "UPDATE __wud_migrations SET id = 5, name = '0005_watched_containers' WHERE id = 9005",
    ).run();
    db.prepare(
        "INSERT INTO watched_containers (watcher, name, watched) VALUES ('docker', 'a', 1)",
    ).run();
    return db;
}

function migrationRows(db: Database.Database) {
    return db
        .prepare('SELECT id, name FROM __wud_migrations ORDER BY id')
        .all() as { id: number; name: string }[];
}

function tableNames(db: Database.Database) {
    return (
        db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as { name: string }[]
    ).map((r) => r.name);
}

describe('runMigrations', () => {
    test('creates every declared table on a fresh database', () => {
        const db = freshDb();
        runMigrations(db);
        const tables = tableNames(db);
        for (const table of ['containers', 'users', 'watched_containers']) {
            expect(tables).toContain(table);
        }
        db.close();
    });

    test('records fork migrations outside upstream id range', () => {
        const db = freshDb();
        runMigrations(db);
        const rows = migrationRows(db);
        // Upstream now legitimately owns id 5; the fork must live outside it.
        expect(rows.find((r) => r.id === 9005)?.name).toBe(
            '9005_watched_containers',
        );
        expect(rows.find((r) => r.id === 5)?.name).toBe(
            '0005_image_and_result_version',
        );
        db.close();
    });

    test('is idempotent: a second run applies nothing', () => {
        const db = freshDb();
        runMigrations(db);
        const before = migrationRows(db);
        runMigrations(db);
        expect(migrationRows(db)).toEqual(before);
        db.close();
    });

    test('renumbers a legacy fork row from 5 to 9005 without re-running it', () => {
        const db = legacyForkDb();
        expect(migrationRows(db).map((r) => r.id)).toContain(5);

        runMigrations(db);

        const rows = migrationRows(db);
        // After the fork row vacates id 5, upstream's own migration claims it.
        expect(rows.find((r) => r.id === 5)?.name).toBe(
            '0005_image_and_result_version',
        );
        const moved = rows.find((r) => r.id === 9005);
        expect(moved?.name).toBe('9005_watched_containers');
        // The data must survive the renumbering untouched.
        const kept = db
            .prepare('SELECT COUNT(*) c FROM watched_containers')
            .get() as { c: number };
        expect(kept.c).toBe(1);
        db.close();
    });

    test('keeps upstream id 5 untouched and still applies the fork migration', () => {
        const db = freshDb();
        runMigrations(db);
        // Upstream already owns id 5 out of the box now.
        db.exec('DROP TABLE watched_containers');

        runMigrations(db);

        const rows = migrationRows(db);
        // Upstream's row is untouched: we must never hijack it.
        expect(rows.find((r) => r.id === 5)?.name).toBe(
            '0005_image_and_result_version',
        );
        // And the fork migration is applied, not skipped.
        expect(rows.find((r) => r.id === 9005)?.name).toBe(
            '9005_watched_containers',
        );
        expect(tableNames(db)).toContain('watched_containers');
        db.close();
    });

    test('self-heals a table that vanished while its journal row survived', () => {
        const db = freshDb();
        runMigrations(db);
        // Journal says applied, table is gone: the migration must be re-run
        // rather than skipped, so the app never boots on a broken schema.
        db.exec('DROP TABLE watched_containers');
        expect(() => runMigrations(db)).not.toThrow();
        expect(tableNames(db)).toContain('watched_containers');
        db.close();
    });

    test('declares a creates list for every table-creating migration', () => {
        const creator = migrations.filter((m) =>
            /CREATE TABLE/i.test(m.sql.join('')),
        );
        for (const m of creator) {
            expect(m.creates?.length).toBeGreaterThan(0);
        }
    });
});

// @ts-nocheck
import express from 'express';
import nocache from 'nocache';
import * as storeContainer from '../store/container';
import * as storeWatchPreference from '../store/watchPreference';
import * as registry from '../registry';
import { getServerConfiguration } from '../configuration';
import { mapComponentsToList } from './component';
import { getAssociatedTriggerIds } from '../triggers/associatedTriggers';
import { requireRole } from './rbac';
import logger from '../log';
const log = logger.child({ component: 'container' });

const router = express.Router();

const serverConfiguration = getServerConfiguration();

/**
 * Return registered watchers.
 * @returns {{id: string}[]}
 */
function getWatchers() {
    return registry.getState().watcher;
}

/**
 * Return registered triggers.
 * @returns {{id: string}[]}
 */
function getTriggers() {
    return registry.getState().trigger;
}

/**
 * Get containers from store.
 * @param query
 * @returns {*}
 */
export function getContainersFromStore(query) {
    return storeContainer.getContainers(query);
}

/**
 * Get all (filtered) containers.
 * @param req
 * @param res
 */
export function getContainers(req, res) {
    const { query } = req;
    res.status(200).json(getContainersFromStore(query));
}

/**
 * Get a container by id.
 * @param req
 * @param res
 */
export function getContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);
    if (container) {
        res.status(200).json(container);
    } else {
        res.sendStatus(404);
    }
}

/**
 * Delete a container by id.
 * @param req
 * @param res
 */
export function deleteContainer(req, res) {
    if (!serverConfiguration.feature.delete) {
        res.sendStatus(403);
    } else {
        const { id } = req.params;
        const container = storeContainer.getContainer(id);
        if (container) {
            storeContainer.deleteContainer(id);
            res.sendStatus(204);
        } else {
            res.sendStatus(404);
        }
    }
}

/**
 * Watch all containers.
 * @param req
 * @param res
 * @returns {Promise<void>}
 */
let currentWatchJobId = null;

export async function watchContainers(req, res) {
    const isAsync = req.query.async === 'true';

    try {
        if (!isAsync) {
            await Promise.all(
                Object.values(getWatchers()).map((watcher) => watcher.watch()),
            );
            return getContainers(req, res);
        }

        if (currentWatchJobId) {
            return res
                .status(202)
                .json({ status: 'started', jobId: currentWatchJobId });
        }

        currentWatchJobId = require('crypto').randomUUID();
        const jobId = currentWatchJobId;

        res.status(202).json({ status: 'started', jobId });

        // Run async
        (async () => {
            try {
                await Promise.all(
                    Object.values(getWatchers()).map((watcher) =>
                        watcher.watch(),
                    ),
                );
            } catch (err) {
                log.error(`Error in background watch: ${err.message}`);
            } finally {
                if (currentWatchJobId === jobId) {
                    currentWatchJobId = null;
                }
            }
        })();
    } catch (e) {
        res.status(500).json({
            error: `Error when watching images (${e.message})`,
            message: e.message,
        });
    }
}

export async function getContainerTriggers(req, res) {
    const { id } = req.params;

    const container = storeContainer.getContainer(id);
    if (container) {
        const associatedTriggerIds = getAssociatedTriggerIds(container);
        const associatedTriggers = mapComponentsToList(getTriggers())
            .filter((trigger) => associatedTriggerIds.has(trigger.id))
            .map((trigger) => {
                const threshold = associatedTriggerIds.get(trigger.id);
                if (threshold === undefined) {
                    return trigger;
                }
                return {
                    ...trigger,
                    configuration: { ...trigger.configuration, threshold },
                };
            });
        res.status(200).json(associatedTriggers);
    } else {
        res.sendStatus(404);
    }
}

/**
 * Run trigger for a specific container.
 * @param {*} req
 * @param {*} res
 */
export async function runTriggerForContainer(req, res) {
    const { id, triggerType, triggerName } = req.params;

    const containerToTrigger = storeContainer.getContainer(id);
    if (containerToTrigger) {
        const triggerToRun = getTriggers()[`${triggerType}.${triggerName}`];
        if (triggerToRun) {
            try {
                await triggerToRun.trigger(containerToTrigger);
                log.info(
                    `Trigger executed with success (type=${triggerType}, name=${triggerName}, container=${JSON.stringify(containerToTrigger)})`,
                );
                res.status(200).json({});
            } catch (e) {
                log.warn(
                    `Error when running trigger (type=${triggerType}, name=${triggerName}) (${e.message})`,
                );
                res.status(500).json({
                    error: 'Trigger execution failed',
                    message: `Error when running trigger (type=${triggerType}, name=${triggerName}) (${e.message})`,
                });
            }
        } else {
            res.status(404).json({
                error: 'Not found',
                message: 'Trigger not found',
            });
        }
    } else {
        res.status(404).json({
            error: 'Not found',
            message: 'Container not found',
        });
    }
}

/**
 * Watch an image.
 * @param req
 * @param res
 * @returns {Promise<void>}
 */
export async function watchContainer(req, res) {
    const { id } = req.params;

    const container = storeContainer.getContainer(id);
    if (container) {
        const watcher = getWatchers()[`docker.${container.watcher}`];
        if (!watcher) {
            res.status(500).json({
                error: 'Provider not found',
                message: `No provider found for container ${id} and provider ${container.watcher}`,
            });
        } else {
            try {
                // Ensure container is still in store
                // (for cases where it has been removed before running an new watchAll)
                const containers = await watcher.getContainers();
                const containerFound = containers.find(
                    (containerInList) => containerInList.id === container.id,
                );

                if (!containerFound) {
                    res.status(404).send();
                } else {
                    // Run watchContainer from the Provider
                    const containerReport =
                        await watcher.watchContainer(container);
                    res.status(200).json(containerReport.container);
                }
            } catch (e) {
                res.status(500).json({
                    error: 'Watch failed',
                    message: `Error when watching container ${id} (${e.message})`,
                });
            }
        }
    } else {
        res.sendStatus(404);
    }
}

/**
 * Snooze container updates.
 * @param req
 * @param res
 */
export function snoozeContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);
    if (!container) {
        return res.sendStatus(404);
    }
    const { version, until } = req.body || {};
    const targetVersion =
        version || container.result?.tag || container.result?.digest;
    if (!targetVersion) {
        return res.status(400).json({
            error: 'Bad request',
            message: 'No candidate version to snooze',
        });
    }
    try {
        const updated = storeContainer.snoozeContainer(
            id,
            targetVersion,
            until,
        );
        return res.status(200).json(updated);
    } catch (e) {
        return res.status(500).json({
            error: 'Snooze failed',
            message: e.message,
        });
    }
}

/**
 * Unsnooze container updates.
 * @param req
 * @param res
 */
export function unsnoozeContainer(req, res) {
    const { id } = req.params;
    const container = storeContainer.getContainer(id);
    if (!container) {
        return res.sendStatus(404);
    }
    try {
        const updated = storeContainer.unsnoozeContainer(id);
        return res.status(200).json(updated);
    } catch (e) {
        return res.status(500).json({
            error: 'Unsnooze failed',
            message: e.message,
        });
    }
}

/**
 * Ask every watcher for the containers it knows about.
 *
 * Returns the flattened list along with the names of the watchers that could
 * not be enumerated (discovery unsupported, or the daemon threw). Callers
 * taking destructive decisions (purging orphan preferences) MUST skip those
 * watchers: a temporary daemon outage would otherwise look like "every
 * container of this watcher has been removed".
 * @returns {Promise<{containers: any[], failedWatchers: string[]}>}
 */
async function collectDiscoveries() {
    const results = await Promise.all(
        Object.entries(getWatchers()).map(async ([id, watcher]) => {
            // Preferences are keyed on the watcher name, which the component
            // exposes. Fall back to the registry id (docker.local -> local)
            // for the unlikely case where it is missing.
            const name = watcher.name || String(id).replace(/^[^.]*\./, '');
            if (typeof watcher.discoverContainers !== 'function') {
                return { name, containers: [], failed: true };
            }
            try {
                return {
                    name,
                    containers: await watcher.discoverContainers(),
                    failed: false,
                };
            } catch (e) {
                log.warn(
                    `Error when discovering containers of watcher ${name} (${e.message})`,
                );
                return { name, containers: [], failed: true };
            }
        }),
    );
    return {
        containers: results.flatMap((result) => result.containers),
        failedWatchers: results
            .filter((result) => result.failed)
            .map((result) => result.name),
    };
}

/**
 * List every container reported by the watchers, including the ones that are
 * not watched. Lets users pick which containers must be monitored.
 * @param req
 * @param res
 */
export async function discoverContainers(req, res) {
    try {
        const { containers } = await collectDiscoveries();
        res.status(200).json({ containers });
    } catch (e) {
        res.status(500).json({
            error: 'Discovery failed',
            message: `Error when discovering containers (${e.message})`,
        });
    }
}

/**
 * Find the preferences pointing to containers no watcher knows about.
 *
 * A preference becomes an orphan when its container is removed or renamed, or
 * when its watcher is no longer configured. Preferences owned by a watcher
 * that failed to answer are deliberately kept: they are probably still valid.
 * @returns {Promise<{orphans: any[], failedWatchers: string[]}>}
 */
async function findOrphanPreferences() {
    const { containers, failedWatchers } = await collectDiscoveries();
    const known = new Set(
        containers.map((container) => `${container.watcher}/${container.name}`),
    );
    const orphans = storeWatchPreference
        .listPreferences()
        .filter(
            (preference) =>
                !failedWatchers.includes(preference.watcher) &&
                !known.has(`${preference.watcher}/${preference.name}`),
        );
    return { orphans, failedWatchers };
}

/**
 * Report the orphan watch preferences. Detection only, nothing is deleted.
 * @param req
 * @param res
 */
export async function listOrphanWatchPreferences(req, res) {
    try {
        res.status(200).json(await findOrphanPreferences());
    } catch (e) {
        res.status(500).json({
            error: 'Orphan detection failed',
            message: `Error when listing orphan watch preferences (${e.message})`,
        });
    }
}

/**
 * Delete every orphan watch preference.
 * @param req
 * @param res
 */
export async function purgeOrphanWatchPreferences(req, res) {
    try {
        const { orphans, failedWatchers } = await findOrphanPreferences();
        const removed = storeWatchPreference.clearWatchedMany(orphans);
        log.info(
            `Purged ${removed.length} orphan watch preference(s) (${failedWatchers.length} watcher(s) skipped)`,
        );
        res.status(200).json({
            removed,
            count: removed.length,
            failedWatchers,
        });
    } catch (e) {
        res.status(500).json({
            error: 'Orphan cleanup failed',
            message: e.message,
        });
    }
}

/**
 * Set the watch preference of a container.
 * Send "watched": null to clear it and fall back to labels / default.
 * @param req
 * @param res
 */
export function setWatchPreference(req, res) {
    const body = req.body || {};
    const { watcher, name, watched } = body;
    if (!watcher || !name) {
        return res.status(400).json({
            error: 'Bad request',
            message: 'watcher and name are required',
        });
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'watched')) {
        return res.status(400).json({
            error: 'Bad request',
            message: 'watched is required (boolean, or null to clear)',
        });
    }
    try {
        if (watched === null) {
            storeWatchPreference.clearWatched(watcher, name);
            return res.status(200).json({ watcher, name, watched: null });
        }
        if (typeof watched !== 'boolean') {
            return res.status(400).json({
                error: 'Bad request',
                message: 'watched must be a boolean or null',
            });
        }
        storeWatchPreference.setWatched(watcher, name, watched);
        return res.status(200).json({ watcher, name, watched });
    } catch (e) {
        return res.status(500).json({
            error: 'Watch preference failed',
            message: e.message,
        });
    }
}

/**
 * Init Router.
 * @returns {*}
 */
export function init() {
    router.use(nocache());
    router.get('/', requireRole(['admin', 'rw', 'ro'], 'read'), getContainers);
    router.post(
        '/watch',
        requireRole(['admin', 'rw'], 'write'),
        watchContainers,
    );
    // Declared before '/:id' on purpose: otherwise the id route swallows them
    router.get(
        '/discover',
        requireRole(['admin', 'rw', 'ro'], 'read'),
        discoverContainers,
    );
    router.put(
        '/watch-preference',
        requireRole(['admin', 'rw'], 'write'),
        setWatchPreference,
    );
    router.get(
        '/watch-preference/orphans',
        requireRole(['admin', 'rw', 'ro'], 'read'),
        listOrphanWatchPreferences,
    );
    router.delete(
        '/watch-preference/orphans',
        requireRole(['admin', 'rw'], 'write'),
        purgeOrphanWatchPreferences,
    );
    router.get(
        '/:id',
        requireRole(['admin', 'rw', 'ro'], 'read'),
        getContainer,
    );
    router.delete(
        '/:id',
        requireRole(['admin', 'rw'], 'write'),
        deleteContainer,
    );
    router.post(
        '/:id/snooze',
        requireRole(['admin', 'rw'], 'write'),
        snoozeContainer,
    );
    router.delete(
        '/:id/snooze',
        requireRole(['admin', 'rw'], 'write'),
        unsnoozeContainer,
    );
    router.get(
        '/:id/triggers',
        requireRole(['admin', 'rw', 'ro'], 'read'),
        getContainerTriggers,
    );
    router.post(
        '/:id/triggers/:triggerType/:triggerName',
        requireRole(['admin', 'rw'], 'write'),
        runTriggerForContainer,
    );
    router.post(
        '/:id/watch',
        requireRole(['admin', 'rw'], 'write'),
        watchContainer,
    );
    return router;
}

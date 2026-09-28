<template>
  <v-container fluid class="pa-4">
    <v-card class="border" elevation="0" rounded="lg">
      <container-filter
        :registries="registries"
        :registry-selected-init="registrySelected"
        :watchers="watchers"
        :watcher-selected-init="watcherSelected"
        :stacks="stacks"
        :stack-selected-init="stackSelected"
        :search-query-init="searchQuery"
        :update-kinds="updateKinds"
        :update-kind-selected-init="updateKindSelected"
        :updateAvailable="updateAvailableSelected"
        :oldestFirst="oldestFirst"
        :groupByLabel="groupByLabel"
        :groupLabels="allContainerLabels"
        :total-count="containers.length"
        :filtered-count="containersFiltered.length"
        :can-write="canWrite"
        @registry-changed="onRegistryChanged"
        @watcher-changed="onWatcherChanged"
        @stack-changed="onStackChanged"
        @search-changed="onSearchChanged"
        @update-available-changed="onUpdateAvailableChanged"
        @oldest-first-changed="onOldestFirstChanged"
        @group-by-label-changed="onGroupByLabelChanged"
        @update-kind-changed="onUpdateKindChanged"
        @reset-filters="onResetFilters"
      />

      <v-divider />

      <v-data-table
        v-model:items-per-page="itemsPerPage"
        :headers="headers"
        :items="containersFiltered"
        item-value="id"
        :group-by="groupBy"
        hover
        class="bg-surface"
        @click:row="onRowClick"
      >
        <template #group-header="{ item, columns, toggleGroup, isGroupOpen }">
          <tr class="v-data-table-group-header-row" @click="toggleGroup(item)">
            <td :colspan="columns.length" class="py-2.5 px-4 group-header-cell">
              <div class="d-flex align-center">
                <v-btn
                  :icon="isGroupOpen(item) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                  size="x-small"
                  variant="tonal"
                  color="primary"
                  density="comfortable"
                  class="mr-3 group-chevron"
                  @click.stop="toggleGroup(item)"
                />

                <v-icon size="small" color="primary" class="mr-1.5 opacity-80">mdi-tag-outline</v-icon>

                <span class="group-label-name text-caption font-weight-bold text-uppercase">
                  {{ groupByLabel }}
                </span>

                <span class="mx-2 text-disabled font-weight-light">/</span>

                <span
                  class="group-label-value font-weight-bold text-body-2"
                  :class="item.value === '(empty)' ? 'text-disabled font-italic' : ''"
                >
                  {{ item.value }}
                </span>

                <v-chip
                  size="x-small"
                  variant="tonal"
                  color="primary"
                  class="ml-3 font-weight-medium"
                >
                  <v-icon start size="x-small">mdi-docker</v-icon>
                  {{ $t('containers.count', { n: item.items.length }) }}
                </v-chip>
              </div>
            </td>
          </tr>
        </template>

        <template #[`item.watcher`]="{ item }">
              <v-chip label color="primary" variant="tonal" size="small">
                <v-icon start size="small">mdi-update</v-icon>
                {{ item.raw ? item.raw.watcher : item.watcher }}
              </v-chip>
            </template>

            <template #[`item.registry`]="{ item }">
              <div class="d-flex align-center">
                <IconRenderer
                  :icon="getRegistryProviderIcon(item.raw ? item.raw?.image?.registry?.name : item.image?.registry?.name)"
                  :size="20"
                  :margin-right="8"
                />
                {{ item.raw ? item.raw?.image?.registry?.name : item.image?.registry?.name }}
              </div>
            </template>

            <template #[`item.stack`]="{ item }">
              <v-chip
                v-if="item.raw ? item.raw.stack : item.stack"
                label
                color="secondary"
                variant="tonal"
                size="small"
                class="font-weight-medium cursor-pointer"
                @click.stop="onStackChipClick(item.raw ? item.raw.stack : item.stack)"
                :title="$t('containers.filterByStack')"
              >
                <v-icon start size="small">mdi-layers-outline</v-icon>
                {{ item.raw ? item.raw.stack : item.stack }}
              </v-chip>
              <span v-else class="text-disabled text-caption">-</span>
            </template>

            <template #[`item.displayName`]="{ item }">
              <div class="d-flex align-center font-weight-medium">
                <IconRenderer
                  :icon="(item.raw ? item.raw.displayIcon : item.displayIcon) || 'mdi:docker'"
                  :size="20"
                  :margin-right="8"
                />
                <span>{{ item.raw ? item.raw.displayName : item.displayName }}</span>
              </div>
            </template>

            <template #[`item.currentVersion`]="{ item }">
              <v-chip label variant="tonal" size="small" class="font-weight-medium">
                {{ item.raw ? item.raw.image.tag.value : item.image.tag.value }}
              </v-chip>
            </template>

            <template #[`item.update`]="{ item }">
              <template v-if="item.raw ? item.raw.updateAvailable : item.updateAvailable">
                <v-tooltip bottom>
                  <template v-slot:activator="{ props }">
                    <v-chip
                      label
                      variant="flat"
                      :color="getNewVersionClass(item.raw || item)"
                      size="small"
                      v-bind="props"
                      @click.stop="copyToClipboard('copy.containerNewVersion', getNewVersion(item.raw || item))"
                      class="cursor-pointer font-weight-bold"
                    >
                      <v-icon start size="small">mdi-arrow-up-bold</v-icon>
                      {{ getNewVersion(item.raw || item) }}
                    </v-chip>
                  </template>
                  <span class="text-caption">{{ $t('containers.copyToClipboard') }}</span>
                </v-tooltip>
              </template>
              <template v-else-if="(item.raw ? item.raw.isSnoozed : item.isSnoozed) || (item.raw ? item.raw.snoozedVersion : item.snoozedVersion)">
                <v-tooltip bottom>
                  <template v-slot:activator="{ props }">
                    <v-chip
                      label
                      variant="tonal"
                      color="warning"
                      size="small"
                      v-bind="props"
                      class="font-weight-medium"
                    >
                      <v-icon start size="small">mdi-bell-sleep</v-icon>
                      {{ $t('containers.snoozed') }} ({{ (item.raw ? item.raw.snoozedVersion : item.snoozedVersion) }})
                    </v-chip>
                  </template>
                  <span>
                    {{ $t('containers.snoozeUpdate') }}{{ (item.raw ? item.raw.snoozedUntil : item.snoozedUntil) ? ` ${$t('containers.untilNextVersion').toLowerCase().replace('until ', 'until ')} ${new Date(item.raw ? item.raw.snoozedUntil : item.snoozedUntil).toLocaleString()}` : '' }}
                  </span>
                </v-tooltip>
              </template>
              <template v-else-if="item.raw ? item.raw.isCoolingDown : item.isCoolingDown">
                <v-tooltip bottom>
                  <template v-slot:activator="{ props }">
                    <v-chip
                      label
                      variant="tonal"
                      color="info"
                      size="small"
                      v-bind="props"
                      class="font-weight-medium"
                    >
                      <v-icon start size="small">mdi-timer-sand</v-icon>
                      {{ $t('containers.coolingDown') }}
                    </v-chip>
                  </template>
                  <span>
                    {{ $t('containers.coolingDown') }}{{ (item.raw ? item.raw.coolingDownUntil : item.coolingDownUntil) ? ` ${new Date(item.raw ? item.raw.coolingDownUntil : item.coolingDownUntil).toLocaleString()}` : '' }}
                  </span>
                </v-tooltip>
              </template>
              <span v-else class="text-grey text-caption">{{ $t('containers.upToDate') }}</span>
            </template>

            <template #[`item.actions`]="{ item }">
              <v-menu location="bottom end">
                <template v-slot:activator="{ props }">
                  <v-btn
                    icon="mdi-dots-vertical"
                    variant="text"
                    size="small"
                    v-bind="props"
                    @click.stop
                    :aria-label="$t('containers.actions')"
                  />
                </template>
                <v-list density="compact">
                  <v-list-item
                    v-if="(item.raw ? item.raw.updateAvailable : item.updateAvailable) && canWrite"
                    prepend-icon="mdi-package-down"
                    :title="$t('containers.updateTitle')"
                    class="text-primary"
                    @click.stop="openUpdateDialog(item.raw || item)"
                  />
                  <v-list-item
                    v-if="(item.raw ? item.raw.updateAvailable : item.updateAvailable) && canWrite"
                    prepend-icon="mdi-bell-sleep"
                    :title="$t('containers.snoozeUpdate')"
                    @click.stop="openSnoozeDialog(item.raw || item)"
                  />
                  <v-list-item
                    v-if="((item.raw ? item.raw.isSnoozed : item.isSnoozed) || (item.raw ? item.raw.snoozedVersion : item.snoozedVersion)) && canWrite"
                    prepend-icon="mdi-bell-ring"
                    :title="$t('containers.unsnoozeUpdate')"
                    @click.stop="executeUnsnooze(item.raw || item)"
                  />
                  <v-list-item
                    v-if="deleteEnabled && canWrite"
                    prepend-icon="mdi-delete"
                    :title="$t('containers.deleteContainer')"
                    class="text-error"
                    @click.stop="confirmDelete(item.raw || item)"
                  />
                </v-list>
              </v-menu>
            </template>

            <template v-slot:no-data>
              <div class="pa-8 text-center text-grey">
                <v-icon size="64" class="mb-4 opacity-50">mdi-docker</v-icon>
                <div class="text-h6">{{ $t('containers.noContainers') }}</div>
                <div class="text-body-2">{{ $t('containers.tryFilters') }}</div>
              </div>
            </template>
          </v-data-table>

        <!-- Containers the watcher reports but that WUD does not monitor.
             Deliberately greyed out: they belong to the picture, not to the
             list above, which only reflects what is actually tracked. -->
        <template v-if="showKnownUnwatchedSection">
          <v-divider />

          <div
            class="known-unwatched-header px-4 py-3 d-flex align-center flex-wrap ga-3"
            @click="showKnownUnwatched = !showKnownUnwatched"
          >
            <v-icon size="20" class="text-medium-emphasis">mdi-eye-off-outline</v-icon>
            <div class="flex-grow-1" style="min-width: 220px">
              <div class="text-body-2 font-weight-medium text-medium-emphasis">
                {{ $t('containers.knownUnwatched') }}
              </div>
              <div class="text-caption text-disabled">
                {{ $t('containers.knownUnwatchedHint') }}
              </div>
            </div>
            <v-chip label size="small" variant="tonal" color="grey" class="font-weight-medium">
              {{ $t('containers.knownUnwatchedCount', { n: knownUnwatchedFiltered.length }) }}
            </v-chip>
            <v-btn
              variant="text"
              size="small"
              color="primary"
              :prepend-icon="showKnownUnwatched ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              @click.stop="showKnownUnwatched = !showKnownUnwatched"
            >
              {{
                showKnownUnwatched
                  ? $t('containers.knownUnwatchedHide')
                  : $t('containers.knownUnwatchedShow')
              }}
            </v-btn>
            <v-btn
              variant="text"
              size="small"
              color="primary"
              prepend-icon="mdi-playlist-check"
              to="/watchlist"
              @click.stop
            >
              {{ $t('containers.openWatchlist') }}
            </v-btn>
          </div>

          <v-expand-transition>
            <div v-if="showKnownUnwatched" class="known-unwatched-body">
              <div
                v-for="container in knownUnwatchedFiltered"
                :key="`${container.watcher}/${container.name}`"
                class="known-unwatched-row px-4 py-2 d-flex align-center flex-wrap ga-3"
              >
                <v-icon size="18" class="text-disabled">mdi-docker</v-icon>
                <span class="font-weight-medium text-medium-emphasis">{{ container.name }}</span>
                <span class="text-caption text-disabled font-monospace">{{ container.image }}</span>
                <v-chip v-if="container.stack" label size="x-small" variant="tonal" color="secondary">
                  {{ container.stack }}
                </v-chip>
                <v-chip label size="x-small" variant="tonal" color="grey">
                  {{ container.watcher }}
                </v-chip>
                <v-chip label size="x-small" variant="tonal" color="grey">
                  {{ container.state }}
                </v-chip>
                <v-spacer />
                <v-btn
                  v-if="canWrite"
                  size="small"
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-eye-plus-outline"
                  :loading="enablingKey === `${container.watcher}/${container.name}`"
                  @click.stop="enableWatch(container)"
                >
                  {{ $t('containers.enableWatch') }}
                </v-btn>
              </div>
            </div>
          </v-expand-transition>
        </template>
        </v-card>

    <!-- Slide-over Container Detail Drawer -->
    <v-navigation-drawer
      v-model="drawerOpen"
      location="right"
      temporary
      :width="640"
      class="border-s"
      elevation="16"
    >
      <template v-if="selectedContainer">
        <!-- Drawer Header -->
        <v-toolbar flat color="surface" class="border-b px-2">
          <div class="d-flex align-center overflow-hidden mr-2" style="flex: 1">
            <IconRenderer
              :icon="selectedContainer.displayIcon || 'mdi:docker'"
              :size="26"
              class="mr-3 flex-shrink-0"
            />
            <div class="text-truncate">
              <div class="text-subtitle-1 font-weight-bold text-truncate">
                {{ selectedContainer.displayName || selectedContainer.name }}
              </div>
              <div class="text-caption text-grey text-truncate">
                {{ selectedContainer.image?.registry?.name }} &bull; {{ selectedContainer.watcher }}
                <template v-if="selectedContainer.stack">
                  &bull; <v-icon size="x-small" class="mr-0.5">mdi-layers-outline</v-icon>{{ selectedContainer.stack }}
                </template>
              </div>
            </div>
          </div>
          <v-btn
            v-if="selectedContainer.updateAvailable && canWrite"
            icon="mdi-package-down"
            color="primary"
            variant="text"
            size="small"
            class="mr-1"
            @click="openUpdateDialog(selectedContainer)"
            :title="$t('containers.updateTitle')"
          ></v-btn>
          <v-btn
            v-if="selectedContainer.updateAvailable && canWrite"
            icon="mdi-bell-sleep"
            color="warning"
            variant="text"
            size="small"
            class="mr-1"
            @click="openSnoozeDialog(selectedContainer)"
            :title="$t('containers.snoozeUpdate')"
          ></v-btn>
          <v-btn
            v-if="(selectedContainer.isSnoozed || selectedContainer.snoozedVersion) && canWrite"
            icon="mdi-bell-ring"
            color="primary"
            variant="text"
            size="small"
            class="mr-1"
            @click="executeUnsnooze(selectedContainer)"
            :title="$t('containers.unsnoozeUpdate')"
          ></v-btn>
          <v-btn
            v-if="deleteEnabled && canWrite"
            icon="mdi-delete"
            color="error"
            variant="text"
            size="small"
            class="mr-1"
            @click="confirmDelete(selectedContainer)"
            :title="$t('containers.deleteContainer')"
          ></v-btn>
          <v-btn icon="mdi-close" variant="text" size="small" @click="drawerOpen = false" :title="$t('containers.closeDetails')"></v-btn>
        </v-toolbar>

        <!-- Drawer Content Tabs -->
        <v-tabs v-model="drawerTab" color="primary" align-tabs="start" density="compact" class="border-b px-2 bg-surface">
          <v-tab value="update" v-if="selectedContainer.result">
            <v-icon start size="small">mdi-package-down</v-icon> {{ $t('containers.tabUpdate') }}
          </v-tab>
          <v-tab value="triggers">
            <v-icon start size="small">mdi-bell-ring</v-icon> {{ $t('containers.tabTriggers') }}
          </v-tab>
          <v-tab value="image">
            <v-icon start size="small">mdi-package-variant-closed</v-icon> {{ $t('containers.tabImage') }}
          </v-tab>
          <v-tab value="container">
            <IconRenderer :icon="selectedContainer.displayIcon || 'mdi:docker'" :size="16" :margin-right="4" /> {{ $t('containers.tabContainer') }}
          </v-tab>
          <v-tab value="error" v-if="selectedContainer.error">
            <v-icon start size="small" color="error">mdi-alert</v-icon> {{ $t('containers.tabError') }}
          </v-tab>
        </v-tabs>

        <!-- Drawer Tab Windows -->
        <div class="pa-4 flex-grow-1 overflow-y-auto" style="max-height: calc(100vh - 104px);">
          <v-window v-model="drawerTab">
            <v-window-item value="update" v-if="selectedContainer.result">
              <container-update
                :result="selectedContainer.result"
                :semver="selectedContainer.image?.tag?.semver"
                :update-kind="selectedContainer.updateKind"
                :update-available="selectedContainer.updateAvailable"
                :is-cooling-down="selectedContainer.isCoolingDown"
                :cooling-down-until="selectedContainer.coolingDownUntil"
                :is-snoozed="selectedContainer.isSnoozed"
                :snoozed-version="selectedContainer.snoozedVersion"
                :snoozed-until="selectedContainer.snoozedUntil"
              />
            </v-window-item>
            <v-window-item value="triggers">
              <container-triggers :container="selectedContainer" />
            </v-window-item>
            <v-window-item value="image">
              <container-image :image="selectedContainer.image" />
            </v-window-item>
            <v-window-item value="container">
              <container-detail :container="selectedContainer" />
            </v-window-item>
            <v-window-item value="error" v-if="selectedContainer.error">
              <container-error :error="selectedContainer.error" />
            </v-window-item>
          </v-window>
        </div>
      </template>
    </v-navigation-drawer>

    <!-- Delete Confirmation Dialog -->
    <v-dialog v-model="dialogDelete" width="500">
      <v-card class="text-center rounded-lg">
        <v-toolbar color="error" flat>
          <v-toolbar-title class="text-white">{{ $t('containers.deleteTitle') }}</v-toolbar-title>
        </v-toolbar>
        <v-card-text class="pt-6 pb-6 text-body-1">
          {{ $t('containers.deleteConfirmPrefix') }}
          <span class="font-weight-bold text-error">{{ containerToDelete?.name }}</span>
          {{ $t('containers.deleteConfirmSuffix') }}
          <br />
          <span class="text-caption text-grey font-italic">{{ $t('containers.deleteNote') }}</span>
        </v-card-text>
        <v-card-actions class="justify-center pb-6">
          <v-btn variant="outlined" @click="dialogDelete = false" class="px-6">{{ $t('containers.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" @click="executeDelete" class="px-6">{{ $t('containers.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snooze Update Dialog -->
    <v-dialog v-model="dialogSnooze" width="500">
      <v-card class="rounded-lg">
        <v-toolbar color="primary" flat>
          <v-toolbar-title class="text-white">
            <v-icon start>mdi-bell-sleep</v-icon>
            {{ $t('containers.snoozeTitle') }}
          </v-toolbar-title>
        </v-toolbar>
        <v-card-text class="pt-4 pb-2 text-body-1">
          <div>
            {{ $t('containers.snoozeFor') }}
            <span class="font-weight-bold">{{ containerToSnooze?.displayName || containerToSnooze?.name }}</span>:
          </div>
          <v-radio-group v-model="snoozeDuration" class="mt-3">
            <v-radio :label="$t('containers.untilNextVersion')" value="indefinitely" />
            <v-radio :label="$t('containers.for1Day')" value="1_day" />
            <v-radio :label="$t('containers.for1Week')" value="1_week" />
            <v-radio :label="$t('containers.for1Month')" value="1_month" />
          </v-radio-group>
        </v-card-text>
        <v-card-actions class="justify-end px-4 pb-4">
          <v-btn variant="outlined" @click="dialogSnooze = false">{{ $t('containers.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="snoozeLoading" @click="executeSnooze">{{ $t('containers.snooze') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Update Container Dialog -->
    <container-update-dialog
      v-if="containerToUpdate"
      v-model="dialogUpdate"
      :container="containerToUpdate"
      @updated="onContainerUpdated"
    />
  </v-container>
</template>

<script lang="ts">
import ContainerFilter from "@/components/ContainerFilter.vue";
import ContainerDetail from "@/components/ContainerDetail.vue";
import ContainerError from "@/components/ContainerError.vue";
import ContainerImage from "@/components/ContainerImage.vue";
import ContainerTriggers from "@/components/ContainerTriggers.vue";
import ContainerUpdate from "@/components/ContainerUpdate.vue";
import ContainerUpdateDialog from "@/components/ContainerUpdateDialog.vue";
import IconRenderer from "@/components/IconRenderer.vue";
import {
  deleteContainer,
  discoverContainers,
  getAllContainers,
  setWatchPreference,
  snoozeContainer,
  unsnoozeContainer,
} from "@/services/container";
import { getRegistryProviderIcon } from "@/services/registry";
import { getUser } from "@/services/auth";
import { eventService } from "@/services/event";
import { defineComponent } from "vue";

export default defineComponent({
  components: {
    ContainerFilter,
    ContainerDetail,
    ContainerError,
    ContainerImage,
    ContainerTriggers,
    ContainerUpdate,
    ContainerUpdateDialog,
    IconRenderer,
  },

  data() {
    let itemsPerPage = 10;
    try {
      const saved = localStorage.getItem("itemsPerPage") || localStorage.itemsPerPage;
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) {
          itemsPerPage = parsed;
        }
      }
    } catch {
      // ignore
    }

    return {
      containers: [] as any[],
      registrySelected: "",
      watcherSelected: "",
      stackSelected: "",
      searchQuery: "",
      updateKindSelected: "",
      updateAvailableSelected: false,
      groupByLabel: "",
      oldestFirst: false,
      currentUser: null as any,
      itemsPerPage,

      drawerOpen: false,
      selectedContainer: null as any,
      drawerTab: "triggers",

      deleteEnabled: false,
      dialogDelete: false,
      containerToDelete: null as any,

      dialogSnooze: false,
      containerToSnooze: null as any,
      snoozeDuration: "indefinitely",
      snoozeLoading: false,

      dialogUpdate: false,
      containerToUpdate: null as any,
      animatedRows: new Set<string>(),

      // Containers the watcher reports but that are not monitored (yet)
      knownUnwatched: [] as any[],
      showKnownUnwatched: false,
      enablingKey: "",
    };
  },

  watch: {
    itemsPerPage(val: number) {
      try {
        localStorage.setItem("itemsPerPage", String(val));
      } catch {
        // ignore
      }
    },
  },

  created() {
    this._onSseContainerAdded = this.onSseContainerAdded.bind(this);
    this._onSseContainerUpdated = this.onSseContainerUpdated.bind(this);
    this._onSseContainerRemoved = this.onSseContainerRemoved.bind(this);
    this._onSseContainerReport = this.onSseContainerReport.bind(this);
    this._onSseWatchStop = this.onSseWatchStop.bind(this);
  },

  async mounted() {
    eventService.on("wud:container-added", this._onSseContainerAdded);
    eventService.on("wud:container-updated", this._onSseContainerUpdated);
    eventService.on("wud:container-removed", this._onSseContainerRemoved);
    eventService.on("wud:container-report", this._onSseContainerReport);
    eventService.on("wud:watch-stop", this._onSseWatchStop);
    this.deleteEnabled = (this as any).$serverConfig?.feature?.delete || false;
    try {
      this.currentUser = await getUser();
    } catch {
      // ignore
    }
  },

  unmounted() {
    eventService.off("wud:container-added", this._onSseContainerAdded);
    eventService.off("wud:container-updated", this._onSseContainerUpdated);
    eventService.off("wud:container-removed", this._onSseContainerRemoved);
    eventService.off("wud:container-report", this._onSseContainerReport);
    eventService.off("wud:watch-stop", this._onSseWatchStop);
  },
  computed: {
    canWrite(): boolean {
      if (!this.currentUser) return true;
      return this.currentUser.role === "admin" || this.currentUser.role === "rw";
    },
    headers() {
      const t = (this as any).$t;
      return [
        {
          title: t("containers.watcher"),
          key: "watcher",
          value: (item: any) => item.watcher || "",
          sortable: true,
        },
        {
          title: t("containers.registry"),
          key: "registry",
          value: (item: any) => item.image?.registry?.name || "",
          sortable: true,
        },
        {
          title: t("containers.stack"),
          key: "stack",
          value: (item: any) => item.stack || "",
          sortable: true,
        },
        {
          title: t("containers.container"),
          key: "displayName",
          value: (item: any) => item.displayName || item.name || "",
          sortable: true,
        },
        {
          title: t("containers.version"),
          key: "currentVersion",
          value: (item: any) => item.image?.tag?.value || "",
          sortRaw: (a: any, b: any) => {
            const aTag = a.image?.tag?.value || "";
            const bTag = b.image?.tag?.value || "";
            return aTag.localeCompare(bTag, undefined, { numeric: true });
          },
          sortable: true,
        },
        {
          title: t("containers.update"),
          key: "update",
          value: (item: any) => (item.updateAvailable ? this.getNewVersion(item) : ""),
          sortRaw: (a: any, b: any) => {
            const aVal = a.updateAvailable ? (this.getNewVersion(a) || "1") : "";
            const bVal = b.updateAvailable ? (this.getNewVersion(b) || "1") : "";
            if (!aVal && !bVal) return 0;
            if (!aVal) return 1;
            if (!bVal) return -1;
            return aVal.localeCompare(bVal, undefined, { numeric: true });
          },
          sortable: true,
        },
        {
          title: t("containers.actions"),
          key: "actions",
          sortable: false,
          align: "end",
        },
      ];
    },
    groupBy() {
      if (this.groupByLabel) {
        return [{ key: "containerGroup", order: "asc" }];
      }
      return [];
    },
    allContainerLabels() {
      const allLabels = this.containers.reduce((acc, container) => {
        return [...acc, ...Object.keys(container.labels ?? {})];
      }, []);
      return [...new Set(allLabels)].sort();
    },
    registries() {
      return [...new Set(this.containers.map((c) => c.image?.registry?.name).filter(Boolean).sort())];
    },
    watchers() {
      return [...new Set(this.containers.map((c) => c.watcher).sort())];
    },
    stacks() {
      const allStacks = this.containers
        .map((c) => c.stack)
        .filter((s) => Boolean(s));
      return [...new Set(allStacks)].sort();
    },
    updateKinds() {
      return [
        ...new Set(
          this.containers
            .filter((c) => c.updateAvailable && c.updateKind?.kind === "tag" && c.updateKind?.semverDiff)
            .map((c) => c.updateKind.semverDiff)
            .sort()
        ),
      ];
    },
    /**
     * Containers the watcher knows about but that are not monitored, narrowed
     * down by the filters that make sense here. The discovery feed carries no
     * registry nor version detail, so those filters are applied separately in
     * showKnownUnwatchedSection.
     */
    knownUnwatchedFiltered() {
      const q = this.searchQuery.toLowerCase().trim();
      return (this.knownUnwatched as any[])
        .filter((c) => (this.watcherSelected ? this.watcherSelected === c.watcher : true))
        .filter((c) => (this.stackSelected ? this.stackSelected === c.stack : true))
        .filter((c) => {
          if (!q) return true;
          return (
            (c.name && c.name.toLowerCase().includes(q)) ||
            (c.image && c.image.toLowerCase().includes(q)) ||
            (c.stack && c.stack.toLowerCase().includes(q)) ||
            (c.watcher && c.watcher.toLowerCase().includes(q))
          );
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },

    /**
     * Hidden as soon as a filter relying on data the discovery feed does not
     * carry is active, otherwise the section would contradict the table above.
     */
    showKnownUnwatchedSection(): boolean {
      return (
        this.knownUnwatchedFiltered.length > 0 &&
        !this.registrySelected &&
        !this.updateKindSelected &&
        !this.updateAvailableSelected &&
        !this.groupByLabel
      );
    },

    containersFiltered() {
      return this.containers
        .filter((c) => (this.registrySelected ? this.registrySelected === c.image?.registry?.name : true))
        .filter((c) => (this.watcherSelected ? this.watcherSelected === c.watcher : true))
        .filter((c) => (this.stackSelected ? this.stackSelected === c.stack : true))
        .filter((c) => (this.updateKindSelected ? this.updateKindSelected === c.updateKind?.semverDiff : true))
        .filter((c) => (this.updateAvailableSelected ? c.updateAvailable : true))
        .filter((c) => {
          if (!this.searchQuery) return true;
          const q = this.searchQuery.toLowerCase().trim();
          return (
            (c.displayName && c.displayName.toLowerCase().includes(q)) ||
            (c.name && c.name.toLowerCase().includes(q)) ||
            (c.stack && c.stack.toLowerCase().includes(q)) ||
            (c.image?.name && c.image.name.toLowerCase().includes(q)) ||
            (c.watcher && c.watcher.toLowerCase().includes(q))
          );
        })
        .map((c) => ({
          ...c,
          containerGroup: this.groupByLabel
            ? (c.labels && c.labels[this.groupByLabel] !== undefined && c.labels[this.groupByLabel] !== null && c.labels[this.groupByLabel] !== ""
                ? String(c.labels[this.groupByLabel])
                : "(empty)")
            : "",
        }))
        .sort((a, b) => {
          if (this.groupByLabel) {
            if (a.containerGroup !== b.containerGroup) {
              if (a.containerGroup === "(empty)") return 1;
              if (b.containerGroup === "(empty)") return -1;
              return a.containerGroup.localeCompare(b.containerGroup);
            }
          }
          const getImageDate = (item: any) => new Date(item.image?.created || 0);
          if (this.oldestFirst) return (getImageDate(a) as any) - (getImageDate(b) as any);
          return (a.displayName || a.name || "").localeCompare(b.displayName || b.name || "");
        });
    },
  },

  methods: {
    getRegistryProviderIcon,

    openContainerDrawer(container: any) {
      this.selectedContainer = container;
      this.drawerTab = container.result ? "update" : "triggers";
      this.drawerOpen = true;
    },

    onRowClick(event: any, row: any) {
      const item = row?.item?.raw || row?.item || row;
      if (item) {
        this.openContainerDrawer(item);
      }
    },

    getNewVersion(container: any) {
      let newVersion = "unknown";
      if (container.result?.created && container.image.created !== container.result.created) {
        newVersion = (this as any).$filters.dateTime(container.result.created);
      }
      if (container.updateKind) {
        newVersion = container.updateKind.remoteValue;
      }
      if (container.updateKind?.kind === "digest") {
        newVersion = (this as any).$filters.short(newVersion, 15);
      }
      return newVersion;
    },

    getNewVersionClass(container: any) {
      if (container.updateKind?.kind === "tag") {
        switch (container.updateKind.semverDiff) {
          case "major": return "error";
          case "minor": return "warning";
          case "patch": return "success";
        }
      }
      return "info";
    },

    copyToClipboard(kind: string, value: string) {
      navigator.clipboard.writeText(value);
      (this as any).$eventBus.emit(
        "notify",
        (this as any).$t("common.copied", { kind: (this as any).$t(kind) }),
      );
    },

    confirmDelete(container: any) {
      this.containerToDelete = container;
      this.dialogDelete = true;
    },

    async executeDelete() {
      if (!this.containerToDelete) return;
      this.dialogDelete = false;
      try {
        await deleteContainer(this.containerToDelete.id);
        this.containers = this.containers.filter((c) => c.id !== this.containerToDelete.id);
        if (this.selectedContainer && this.selectedContainer.id === this.containerToDelete.id) {
          this.drawerOpen = false;
          this.selectedContainer = null;
        }
      } catch (e: any) {
        (this as any).$eventBus.emit("notify", (this as any).$t("containers.deleteError", { msg: e.message }), "error");
      }
      this.containerToDelete = null;
    },

    onSseContainerAdded(container: any) {
      if (!container || !container.id) return;
      const idx = this.containers.findIndex((c) => c.id === container.id);
      if (idx !== -1) {
        this.containers[idx] = { ...this.containers[idx], ...container };
      } else {
        this.containers.push(container);
      }
      if (this.selectedContainer && this.selectedContainer.id === container.id) {
        this.selectedContainer = { ...this.selectedContainer, ...container };
      }
      this.animatedRows.add(container.id);
      setTimeout(() => {
        this.animatedRows.delete(container.id);
      }, 2000);
    },

    onSseContainerUpdated(container: any) {
      if (!container || !container.id) return;
      const idx = this.containers.findIndex((c) => c.id === container.id);
      if (idx !== -1) {
        this.containers[idx] = { ...this.containers[idx], ...container };
      } else {
        this.containers.push(container);
      }
      if (this.selectedContainer && this.selectedContainer.id === container.id) {
        this.selectedContainer = { ...this.selectedContainer, ...container };
      }
      this.animatedRows.add(container.id);
      setTimeout(() => {
        this.animatedRows.delete(container.id);
      }, 2000);
    },

    onSseContainerRemoved(container: any) {
      const id = typeof container === "string" ? container : container?.id;
      if (!id) return;
      this.containers = this.containers.filter((c) => c.id !== id);
      if (this.selectedContainer && this.selectedContainer.id === id) {
        this.drawerOpen = false;
        this.selectedContainer = null;
      }
    },

    onSseContainerReport(report: any) {
      if (report?.container) {
        this.onSseContainerUpdated(report.container);
      } else if (report?.id) {
        this.onSseContainerUpdated(report);
      }
    },

    async onSseWatchStop() {
      await this.refreshContainers();
    },

    async refreshContainers() {
      try {
        this.containers = (await getAllContainers()) || [];
      } catch (e: any) {
        (this as any).$eventBus?.emit(
          "notify",
          this.$t("containers.refreshContainersError", { msg: e.message }),
          "error",
        );
      }
    },

    openUpdateDialog(container: any) {
      this.containerToUpdate = container;
      this.dialogUpdate = true;
    },

    async onContainerUpdated() {
      await this.refreshContainers();
    },

    openSnoozeDialog(container: any) {
      this.containerToSnooze = container;
      this.snoozeDuration = "indefinitely";
      this.dialogSnooze = true;
    },

    async executeSnooze() {
      if (!this.containerToSnooze) return;
      this.snoozeLoading = true;
      try {
        let until: number | undefined;
        const now = Date.now();
        if (this.snoozeDuration === "1_day") {
          until = now + 24 * 60 * 60 * 1000;
        } else if (this.snoozeDuration === "1_week") {
          until = now + 7 * 24 * 60 * 60 * 1000;
        } else if (this.snoozeDuration === "1_month") {
          until = now + 30 * 24 * 60 * 60 * 1000;
        }

        const targetVersion =
          this.containerToSnooze.updateKind?.remoteValue ||
          this.containerToSnooze.result?.tag ||
          this.containerToSnooze.result?.digest;

        const updated = await snoozeContainer(this.containerToSnooze.id, {
          version: targetVersion,
          until,
        });

        this.containers = this.containers.map((c) =>
          c.id === updated.id ? { ...c, ...updated } : c,
        );
        if (this.selectedContainer && this.selectedContainer.id === updated.id) {
          this.selectedContainer = { ...this.selectedContainer, ...updated };
        }
        (this as any).$eventBus.emit("notify", (this as any).$t("containers.snoozedOk"));
        this.dialogSnooze = false;
      } catch (e: any) {
        (this as any).$eventBus.emit(
          "notify",
          (this as any).$t("containers.snoozeFail", { msg: e.message }),
          "error",
        );
      } finally {
        this.snoozeLoading = false;
        this.containerToSnooze = null;
      }
    },

    async executeUnsnooze(container: any) {
      if (!container) return;
      try {
        const updated = await unsnoozeContainer(container.id);
        this.containers = this.containers.map((c) =>
          c.id === updated.id ? { ...c, ...updated } : c,
        );
        if (this.selectedContainer && this.selectedContainer.id === updated.id) {
          this.selectedContainer = { ...this.selectedContainer, ...updated };
        }
        (this as any).$eventBus.emit("notify", (this as any).$t("containers.unsnoozedOk"));
      } catch (e: any) {
        (this as any).$eventBus.emit(
          "notify",
          (this as any).$t("containers.unsnoozeFail", { msg: e.message }),
          "error",
        );
      }
    },

    onRegistryChanged(val: string) { this.registrySelected = val; this.updateQueryParams(); },
    onWatcherChanged(val: string) { this.watcherSelected = val; this.updateQueryParams(); },
    onStackChanged(val: string) { this.stackSelected = val; this.updateQueryParams(); },
    onStackChipClick(stackName: string) {
      this.stackSelected = this.stackSelected === stackName ? "" : stackName;
      this.updateQueryParams();
    },
    onSearchChanged(val: string) { this.searchQuery = val; },
    onUpdateAvailableChanged() { this.updateAvailableSelected = !this.updateAvailableSelected; this.updateQueryParams(); },
    onOldestFirstChanged() { this.oldestFirst = !this.oldestFirst; this.updateQueryParams(); },
    onGroupByLabelChanged(val: string) { this.groupByLabel = val; this.updateQueryParams(); },
    onUpdateKindChanged(val: string) { this.updateKindSelected = val; this.updateQueryParams(); },

    onResetFilters() {
      this.registrySelected = "";
      this.watcherSelected = "";
      this.stackSelected = "";
      this.searchQuery = "";
      this.updateKindSelected = "";
      this.groupByLabel = "";
      this.updateAvailableSelected = false;
      this.oldestFirst = false;
      this.updateQueryParams();
    },
    updateQueryParams() {
      const query: any = {};
      if (this.registrySelected) query["registry"] = this.registrySelected;
      if (this.watcherSelected) query["watcher"] = this.watcherSelected;
      if (this.stackSelected) query["stack"] = this.stackSelected;
      if (this.updateKindSelected) query["update-kind"] = this.updateKindSelected;
      if (this.updateAvailableSelected) query["update-available"] = String(this.updateAvailableSelected);
      if (this.oldestFirst) query["oldest-first"] = String(this.oldestFirst);
      if (this.groupByLabel) query["group-by-label"] = this.groupByLabel;
      this.$router.push({ query });
    },
    onRefreshAllContainers(containersRefreshed: any[]) {
      this.containers = containersRefreshed;
      if (this.selectedContainer) {
        const updated = this.containers.find((c) => c.id === this.selectedContainer.id);
        if (updated) {
          this.selectedContainer = updated;
        }
      }
    },

    /**
     * Start monitoring a container the watcher reported but that WUD ignores.
     * Recording the preference is enough: the container joins the main list
     * at the next scan.
     */
    async enableWatch(container: any) {
      const key = `${container.watcher}/${container.name}`;
      this.enablingKey = key;
      try {
        await setWatchPreference({
          watcher: container.watcher,
          name: container.name,
          watched: true,
        });
        // Drop the row from this section: it is monitored from now on, and
        // will show up in the table above after the next scan.
        this.knownUnwatched = this.knownUnwatched.filter(
          (c) => `${c.watcher}/${c.name}` !== key,
        );
        (this as any).$eventBus.emit(
          "notify",
          (this as any).$t("containers.enableWatchOk", { name: container.name }),
          "success",
        );
      } catch (e: any) {
        (this as any).$eventBus.emit(
          "notify",
          (this as any).$t("containers.enableWatchError", { msg: e.message }),
          "error",
        );
      } finally {
        this.enablingKey = "";
      }
    },
  },

  async beforeRouteEnter(to, from, next) {
    const rs = to.query["registry"];
    const ws = to.query["watcher"];
    const ss = to.query["stack"];
    const uk = to.query["update-kind"];
    const ua = to.query["update-available"];
    const of = to.query["oldest-first"];
    const gl = to.query["group-by-label"];

    try {
      const containers = await getAllContainers();

      // Discovery drives the "known but not monitored" section. It is a
      // bonus: a watcher that fails must not prevent the container list from
      // rendering, so the failure is swallowed on purpose.
      let discovered: any[] = [];
      try {
        discovered = await discoverContainers();
      } catch {
        discovered = [];
      }
      const monitored = new Set(
        containers.map((container: any) => `${container.watcher}/${container.name}`),
      );
      const knownUnwatched = discovered.filter(
        (container) =>
          !container.watched &&
          // A wud.watch label is an explicit decision, and it always wins:
          // advertising it as something to enable from here would be a lie.
          container.watchedBy !== "label" &&
          !monitored.has(`${container.watcher}/${container.name}`),
      );

      next((vm: any) => {
        if (rs) vm.registrySelected = rs;
        if (ws) vm.watcherSelected = ws;
        if (ss) vm.stackSelected = ss;
        if (uk) vm.updateKindSelected = uk;
        if (ua) vm.updateAvailableSelected = String(ua).toLowerCase() === "true";
        if (of) vm.oldestFirst = String(of).toLowerCase() === "true";
        if (gl) vm.groupByLabel = gl;
        vm.containers = containers;
        vm.knownUnwatched = knownUnwatched;
      });
    } catch (e: any) {
      next((vm: any) => {
        vm.$eventBus.emit("notify", (this as any).$t("containers.containersError", { msg: e.message }), "error");
      });
    }
  },
});
</script>

<style scoped>
.cursor-pointer {
  cursor: pointer;
}

.font-monospace {
  font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}

/* "Known but not monitored" section: greyed out, because these containers are
   reported by the watcher but are not part of what WUD tracks. */
.known-unwatched-header {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s ease;
}

.known-unwatched-header:hover {
  background-color: rgba(var(--v-theme-primary), 0.04);
}

.known-unwatched-body {
  max-height: 340px;
  overflow-y: auto;
  border-top: 1px dashed rgba(var(--v-theme-on-surface), 0.12);
}

.known-unwatched-row {
  opacity: 0.75;
  border-bottom: 1px dashed rgba(var(--v-theme-on-surface), 0.08);
  transition: opacity 0.2s ease, background-color 0.2s ease;
}

.known-unwatched-row:last-child {
  border-bottom: none;
}

.known-unwatched-row:hover {
  opacity: 1;
  background-color: rgba(var(--v-theme-primary), 0.04);
}

/* Group header styling with theme-aware accent and gradient */
.group-header-cell {
  background: linear-gradient(90deg, rgba(var(--v-theme-primary), 0.08) 0%, rgba(var(--v-theme-primary), 0.02) 100%);
  border-left: 3px solid rgb(var(--v-theme-primary)) !important;
  border-bottom: 1px solid rgba(var(--v-theme-primary), 0.12) !important;
  transition: background 0.2s ease;
  user-select: none;
}

.group-label-name {
  color: rgb(var(--v-theme-primary));
  letter-spacing: 0.04em;
  opacity: 0.9;
}

.group-label-value {
  color: rgba(var(--v-theme-on-surface), 0.95);
}

.group-chevron {
  transition: transform 0.2s ease;
}

:deep(.v-data-table tbody tr.v-data-table-group-header-row) {
  cursor: pointer;
}

:deep(.v-data-table tbody tr.v-data-table-group-header-row:hover) {
  transform: none;
  box-shadow: none;
}

:deep(.v-data-table tbody tr.v-data-table-group-header-row:hover .group-header-cell) {
  background: linear-gradient(90deg, rgba(var(--v-theme-primary), 0.15) 0%, rgba(var(--v-theme-primary), 0.05) 100%);
}

/* Add micro-animation and pointer cursor for hover on standard rows */
:deep(.v-data-table tbody tr:not(.v-data-table-group-header-row)) {
  cursor: pointer;
  transition: background-color 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s ease;
}

:deep(.v-data-table tbody tr:not(.v-data-table-group-header-row):hover) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  z-index: 1;
  position: relative;
}

/* Subtle icon bounce on hover */
:deep(.v-data-table tbody tr:hover .icon-renderer) {
  transform: scale(1.1);
  transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

@keyframes row-flash-anim {
  0% { background-color: rgba(var(--v-theme-primary), 0.3); }
  100% { background-color: transparent; }
}

:deep(.v-data-table tbody tr.row-flash) {
  animation: row-flash-anim 2s ease-out;
}
</style>

<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    max-width="520"
  >
    <v-card class="rounded-lg">
      <v-toolbar color="surface" density="compact" class="border-b px-2">
        <v-icon color="primary" class="mr-2">mdi-test-tube</v-icon>
        <v-toolbar-title class="text-subtitle-1 font-weight-bold">
          {{ $t('triggerTest.title') }}
        </v-toolbar-title>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="close"></v-btn>
      </v-toolbar>

      <v-card-text class="pa-4">
        <div class="text-caption text-grey mb-3">
          {{ $t('triggerTest.introPrefix') }}<strong class="text-high-emphasis">{{ trigger?.type }} / {{ trigger?.name }}</strong>{{ $t('triggerTest.introSuffix') }}
        </div>

        <v-autocomplete
          :label="$t('triggerTest.sourceContainer')"
          v-model="selectedContainerId"
          :items="containerOptions"
          variant="outlined"
          density="compact"
          hide-details
          clearable
          class="mb-3"
        />

        <v-text-field
          :label="$t('triggerTest.containerId')"
          v-model="container.id"
          :disabled="!!selectedContainerId"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          :label="$t('triggerTest.containerName')"
          v-model="container.name"
          :disabled="!!selectedContainerId"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          :label="$t('triggerTest.containerWatcher')"
          v-model="container.watcher"
          :disabled="!!selectedContainerId"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-select
          :label="$t('triggerTest.updateKind')"
          v-model="container.updateKind.kind"
          :items="['digest', 'tag']"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-select
          v-if="container.updateKind.kind === 'tag'"
          :label="$t('triggerTest.updateSemverDiff')"
          v-model="container.updateKind.semverDiff"
          :items="['major', 'minor', 'patch']"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          :label="$t('triggerTest.localValue')"
          v-model="container.updateKind.localValue"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          :label="$t('triggerTest.remoteValue')"
          v-model="container.updateKind.remoteValue"
          variant="outlined"
          density="compact"
          hide-details
          class="mb-3"
        />

        <v-text-field
          :label="$t('triggerTest.releaseNotes')"
          v-model="container.updateKind.result.link"
          variant="outlined"
          density="compact"
          hide-details
        />
      </v-card-text>

      <v-divider />

      <v-card-actions class="pa-3 justify-end bg-surface">
        <v-btn variant="outlined" size="small" @click="close">
          {{ $t('containers.cancel') }}
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          @click="executeTrigger"
          :loading="isTriggering"
          prepend-icon="mdi-play"
        >
          {{ $t('triggerTest.run') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { getAllContainers } from "@/services/container";
import { runTrigger } from "@/services/trigger";
import { defineComponent } from "vue";

export default defineComponent({
  name: "TriggerTestDialog",
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    trigger: {
      type: Object,
      required: true,
    },
  },
  emits: ["update:modelValue"],
  data() {
    return {
      isTriggering: false,
      containers: [] as any[],
      selectedContainerId: null as string | null,
      container: {
        id: "123456789",
        name: "container_test",
        watcher: "watcher_test",
        stack: "test-stack",
        labels: {
          "com.docker.compose.project.working_dir": "/opt/docker/container_test",
          "com.docker.compose.service": "container_test",
        },
        updateKind: {
          kind: "tag",
          semverDiff: "major",
          localValue: "1.2.3",
          remoteValue: "4.5.6",
          result: {
            link: "https://my-container/release-notes/",
          },
        },
      },
    };
  },
  computed: {
    containerOptions(): any[] {
      const mockOption = {
        title: (this as any).$t("triggerTest.mockContainer"),
        value: null,
      };
      const realOptions = (this.containers || []).map((c: any) => ({
        title: `${c.name} (${c.watcher})`,
        value: c.id,
      }));
      return [mockOption, ...realOptions];
    },
  },
  watch: {
    async modelValue(val: boolean) {
      if (val) {
        await this.loadContainers();
      }
    },
    selectedContainerId(newId: string | null) {
      if (newId) {
        const selected = (this.containers || []).find((c: any) => c.id === newId);
        if (selected) {
          this.container.id = selected.id;
          this.container.name = selected.name;
          this.container.watcher = selected.watcher;
          if (selected.image?.tag?.value) {
            this.container.updateKind.localValue = selected.image.tag.value;
          }
        }
      } else {
        this.container.id = "123456789";
        this.container.name = "container_test";
        this.container.watcher = "watcher_test";
        this.container.updateKind.localValue = "1.2.3";
      }
    },
  },
  async mounted() {
    await this.loadContainers();
  },
  methods: {
    async loadContainers() {
      try {
        this.containers = (await getAllContainers()) || [];
      } catch {
        this.containers = [];
      }
    },
    close() {
      this.$emit("update:modelValue", false);
    },
    async executeTrigger() {
      if (!this.trigger) return;
      this.isTriggering = true;
      try {
        let payload: any;
        if (this.selectedContainerId) {
          const selectedContainer = (this.containers || []).find(
            (c: any) => c.id === this.selectedContainerId,
          );
          payload = selectedContainer
            ? JSON.parse(JSON.stringify(selectedContainer))
            : JSON.parse(JSON.stringify(this.container));
          payload.updateAvailable = true;
          payload.updateKind = { ...this.container.updateKind };
          if (!payload.result) payload.result = {};
          if (this.container.updateKind.kind === "tag") {
            payload.result.tag = this.container.updateKind.remoteValue;
          } else if (this.container.updateKind.kind === "digest") {
            payload.result.digest = this.container.updateKind.remoteValue;
          }
          payload.result.link = this.container.updateKind.result.link;
        } else {
          payload = this.container;
        }

        await runTrigger({
          triggerType: this.trigger.type,
          triggerName: this.trigger.name,
          container: payload,
        });
        (this as any).$eventBus?.emit(
          "notify",
          (this as any).$t("triggers.success"),
        );
        this.close();
      } catch (err: any) {
        (this as any).$eventBus?.emit(
          "notify",
          (this as any).$t("triggers.error", { msg: err.message }),
          "error",
        );
      } finally {
        this.isTriggering = false;
      }
    },
  },
});
</script>

<template>
  <v-list density="compact">
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-identifier</v-icon>
      </template>
      <v-list-item-title>
        {{ $t('detail.id') }}
        <v-tooltip bottom>
          <template v-slot:activator="{ props }">
            <v-btn
              variant="text"
              size="small"
              icon
              v-bind="props"
              @click="copyToClipboard('copy.imageId', image.id)"
            >
              <v-icon size="small">mdi-clipboard</v-icon>
            </v-btn>
          </template>
          <span class="text-caption">{{ $t('containers.copyToClipboard') }}</span>
        </v-tooltip>
      </v-list-item-title>
      <v-list-item-subtitle>{{ image.id }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-pencil</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.name') }}</v-list-item-title>
      <v-list-item-subtitle>{{ image.name }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">{{ registryIcon }}</v-icon>
      </template>
      <v-list-item-title>{{ $t('containers.registry') }}</v-list-item-title>
      <v-list-item-subtitle>{{ image.registry.name }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-tag</v-icon>
      </template>
      <v-list-item-title>
        {{ $t('update.tag') }} &nbsp;<v-chip v-if="image.tag.semver" size="x-small" variant="outlined" color="success" label
          >{{ $t('update.semver') }}</v-chip
        >
      </v-list-item-title>
      <v-list-item-subtitle>
        {{ image.tag.value }}
      </v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="image.digest.value">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-function-variant</v-icon>
      </template>
      <v-list-item-title>
        {{ $t('update.digest') }}
        <v-tooltip bottom>
          <template v-slot:activator="{ props }">
            <v-btn
              variant="text"
              size="small"
              icon
              v-bind="props"
              @click="copyToClipboard('copy.imageDigest', image.digest.value)"
            >
              <v-icon size="small">mdi-clipboard</v-icon>
            </v-btn>
          </template>
          <span class="text-caption">{{ $t('containers.copyToClipboard') }}</span>
        </v-tooltip>
      </v-list-item-title>
      <v-list-item-subtitle>
        {{ image.digest.value }}
      </v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">{{ osIcon }}</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.osArch') }}</v-list-item-title>
      <v-list-item-subtitle
        >{{ image.os }} / {{ image.architecture }}</v-list-item-subtitle
      >
    </v-list-item>
    <v-list-item v-if="image.created">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-calendar</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.created') }}</v-list-item-title>
      <v-list-item-subtitle>{{
        $filters.date(image.created)
      }}</v-list-item-subtitle>
    </v-list-item>
  </v-list>
</template>

<script lang="ts">
import { getRegistryProviderIcon } from "@/services/registry";
import { copyToClipboard } from "@/services/clipboard";
import { defineComponent } from "vue";

export default defineComponent({
  props: {
    image: {
      type: Object,
      required: true,
    },
  },
  data() {
    return {};
  },
  computed: {
    registryIcon() {
      return getRegistryProviderIcon(this.image.registry.name);
    },

    osIcon() {
      let icon = "mdi-help";
      switch (this.image.os) {
        case "linux":
          icon = "mdi-linux";
          break;
        case "windows":
          icon = "mdi-microsoft-windows";
          break;
      }
      return icon;
    },
  },

  methods: {
    async copyToClipboard(kind: string, value: string) {
      const copied = await copyToClipboard(value);
      if (copied) {
        (this as any).$eventBus.emit(
          "notify",
          this.$t("common.copied", { kind: this.$t(kind) }),
        );
      } else {
        (this as any).$eventBus.emit(
          "notify",
          this.$t("common.copyFailed", { kind: this.$t(kind) }),
          "warning",
        );
      }
    },
  },
});
</script>

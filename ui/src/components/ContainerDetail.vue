<template>
  <v-list density="compact">
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-identifier</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.id') }}</v-list-item-title>
      <v-list-item-subtitle>
        {{ container.id }}
        <v-tooltip bottom>
          <template v-slot:activator="{ props }">
            <v-btn
              variant="text"
              size="small"
              icon
              v-bind="props"
              @click="copyToClipboard('copy.containerId', container.id)"
            >
              <v-icon size="small">mdi-clipboard</v-icon>
            </v-btn>
          </template>
          <span class="text-caption">{{ $t('containers.copyToClipboard') }}</span>
        </v-tooltip>
      </v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-pencil</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.name') }}</v-list-item-title>
      <v-list-item-subtitle>{{ container.name }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="container.stack">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-layers-outline</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.stack') }}</v-list-item-title>
      <v-list-item-subtitle>{{ container.stack }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-restart</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.status') }}</v-list-item-title>
      <v-list-item-subtitle>{{ container.status }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item>
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-update</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.watcher') }}</v-list-item-title>
      <v-list-item-subtitle>
        <router-link to="/configuration/watchers">{{
          container.watcher
        }}</router-link>
      </v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="container.includeTags">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-tag</v-icon>
      </template>
      <v-list-item-title>
        {{ $t('detail.includeTags') }}
        <v-tooltip bottom>
          <template v-slot:activator="{ props }">
            <v-btn
              x-small
              icon
              v-bind="props"
              href="https://regex101.com"
              target="_blank"
            >
              <v-icon>mdi-regex</v-icon>
            </v-btn>
          </template>
          <span>{{ $t('detail.testRegex101') }}</span>
        </v-tooltip>
      </v-list-item-title>
      <v-list-item-subtitle>{{ container.includeTags }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="container.excludeTags">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-tag-off</v-icon>
      </template>
      <v-list-item-title>
        {{ $t('detail.excludeTags') }}
        <v-tooltip bottom>
          <template v-slot:activator="{ props }">
            <v-btn
              x-small
              icon
              v-bind="props"
              href="https://regex101.com"
              target="_blank"
            >
              <v-icon>mdi-regex</v-icon>
            </v-btn>
          </template>
          <span>{{ $t('detail.testRegex101') }}</span>
        </v-tooltip>
      </v-list-item-title>
      <v-list-item-subtitle>{{ container.excludeTags }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="container.transformTags">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-tag-arrow-right</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.transformTags') }}</v-list-item-title>
      <v-list-item-subtitle>{{
        container.transformTags
      }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="container.linkTemplate">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-file-replace</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.linkTemplate') }}</v-list-item-title>
      <v-list-item-subtitle>{{
        container.linkTemplate
      }}</v-list-item-subtitle>
    </v-list-item>
    <v-list-item v-if="container.link">
      <template v-slot:prepend>
        <v-icon color="secondary">mdi-link</v-icon>
      </template>
      <v-list-item-title>{{ $t('detail.link') }}</v-list-item-title>
      <v-list-item-subtitle
        ><a :href="container.link" target="_blank">{{ container.link }}</a>
      </v-list-item-subtitle>
    </v-list-item>
  </v-list>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import { copyToClipboard } from "@/services/clipboard";

export default defineComponent({
  props: {
    container: {
      type: Object,
      required: true,
    },
  },
  data() {
    return {};
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

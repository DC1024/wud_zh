<template>
  <div>
    <v-alert
      v-if="isCoolingDown"
      color="info"
      variant="tonal"
      density="compact"
      icon="mdi-timer-sand"
      class="mb-3"
    >
      <div class="font-weight-medium">{{ $t('update.coolingDownTitle') }}</div>
      <div class="text-caption">
        {{ $t('update.coolingDownText', { until: coolingDownUntilText }) }}
      </div>
    </v-alert>

    <v-alert
      v-if="isSnoozed || snoozedVersion"
      color="warning"
      variant="tonal"
      density="compact"
      icon="mdi-bell-sleep"
      class="mb-3"
    >
      <div class="font-weight-medium">{{ $t('update.snoozedTitle') }}</div>
      <div class="text-caption">
        {{ $t('update.snoozedText', { version: snoozedVersion, until: snoozedUntilText }) }}
      </div>
    </v-alert>

    <v-list density="compact" v-if="updateAvailable || isCoolingDown || isSnoozed || snoozedVersion">
      <v-list-item v-if="result.tag">
        <template v-slot:prepend>
          <v-icon color="secondary">mdi-tag</v-icon>
        </template>
        <v-list-item-title>
          {{ $t('update.tag') }}
          <v-chip v-if="semver" size="x-small" variant="outlined" color="success" label
            >{{ $t('update.semver') }}</v-chip
          >
        </v-list-item-title>
        <v-list-item-subtitle>
          {{ result.tag }}
          <v-tooltip bottom>
            <template v-slot:activator="{ props }">
              <v-btn
                variant="text"
                size="small"
                icon
                v-bind="props"
                @click="copyToClipboard('copy.updateTag', result.tag)"
              >
                <v-icon size="small">mdi-clipboard</v-icon>
              </v-btn>
            </template>
            <span class="text-caption">{{ $t('containers.copyToClipboard') }}</span>
          </v-tooltip>
        </v-list-item-subtitle>
      </v-list-item>
      <v-list-item v-if="result.version">
        <template v-slot:prepend>
          <v-icon color="secondary">mdi-package-variant</v-icon>
        </template>
        <v-list-item-title>{{ $t('update.version') }}</v-list-item-title>
        <v-list-item-subtitle>
          {{ result.version }}
        </v-list-item-subtitle>
      </v-list-item>
      <v-list-item v-if="result.created">
        <template v-slot:prepend>
          <v-icon color="secondary">mdi-calendar-clock</v-icon>
        </template>
        <v-list-item-title>{{ $t('update.built') }}</v-list-item-title>
        <v-list-item-subtitle>
          {{ $filters.dateTime(result.created) }}
        </v-list-item-subtitle>
      </v-list-item>
      <v-list-item v-if="result.link">
        <template v-slot:prepend>
          <v-icon color="secondary">mdi-link</v-icon>
        </template>
        <v-list-item-title>{{ $t('update.link') }}</v-list-item-title>
        <v-list-item-subtitle
          ><a :href="result.link" target="_blank">{{ result.link }}</a>
        </v-list-item-subtitle>
      </v-list-item>
      <v-list-item v-if="result.digest">
        <template v-slot:prepend>
          <v-icon color="secondary">mdi-function-variant</v-icon>
        </template>
        <v-list-item-title> {{ $t('update.digest') }} </v-list-item-title>
        <v-list-item-subtitle>
          {{ result.digest }}
          <v-tooltip bottom>
            <template v-slot:activator="{ props }">
              <v-btn
                variant="text"
                size="small"
                icon
                v-bind="props"
                @click="copyToClipboard('copy.updateDigest', result.digest)"
              >
                <v-icon size="small">mdi-clipboard</v-icon>
              </v-btn>
            </template>
            <span class="text-caption">{{ $t('containers.copyToClipboard') }}</span>
          </v-tooltip>
        </v-list-item-subtitle>
      </v-list-item>
      <v-list-item v-if="updateKind && updateKind.kind && updateKind.kind !== 'unknown'">
        <template v-slot:prepend>
          <v-icon v-if="updateKind.semverDiff === 'patch'" color="success"
            >mdi-information</v-icon
          >
          <v-icon v-else-if="updateKind.semverDiff === 'major'" color="error"
            >mdi-alert-decagram</v-icon
          >
          <v-icon v-else color="warning">mdi-alert</v-icon>
        </template>
        <v-list-item-title>{{ $t('update.kind') }}</v-list-item-title>
        <v-list-item-subtitle>
          {{ updateKindFormatted }}
        </v-list-item-subtitle>
      </v-list-item>
    </v-list>
    <v-card-text v-else>{{ $t('update.none') }}</v-card-text>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
  props: {
    semver: {
      type: Boolean,
    },
    result: {
      type: Object,
    },
    updateKind: {
      type: Object,
    },
    updateAvailable: {
      type: Boolean,
    },
    isCoolingDown: {
      type: Boolean,
      default: false,
    },
    coolingDownUntil: {
      type: Number,
      default: null,
    },
    isSnoozed: {
      type: Boolean,
      default: false,
    },
    snoozedVersion: {
      type: String,
      default: "",
    },
    snoozedUntil: {
      type: Number,
      default: null,
    },
  },
  computed: {
    coolingDownUntilText(): string {
      if (!this.coolingDownUntil) return "";
      return (
        " " +
        this.$t("update.until", {
          date: new Date(this.coolingDownUntil).toLocaleString(),
        })
      );
    },
    snoozedUntilText(): string {
      if (this.snoozedUntil) {
        return (
          " " +
          this.$t("update.until", {
            date: new Date(this.snoozedUntil).toLocaleString(),
          })
        );
      }
      return this.$t("update.indefinitely");
    },
    updateKindFormatted() {
      let kind = "Unknown";
      if (this.updateKind) {
        kind = this.updateKind.kind;
      }
      if (this.updateKind?.semverDiff) {
        kind = this.updateKind.semverDiff;
      }
      return kind;
    },
  },
  methods: {
    copyToClipboard(kind: string, value: string) {
      navigator.clipboard.writeText(value);
      (this as any).$eventBus.emit(
        "notify",
        this.$t("common.copied", { kind: this.$t(kind) }),
      );
    },
  },
});
</script>

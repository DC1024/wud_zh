<template>
  <div class="py-4">
    <div class="text-center mb-6">
      <v-avatar color="primary" variant="tonal" size="56" class="mb-3 rounded-lg">
        <v-icon size="32" color="primary">mdi-shield-account-outline</v-icon>
      </v-avatar>
      <div class="text-subtitle-1 font-weight-bold text-high-emphasis">
        {{ $t('login.ssoTitle') }}
      </div>
      <div class="text-body-2 text-medium-emphasis">
        {{ $t('login.ssoHint', { name: displayName }) }}
      </div>
    </div>

    <v-btn
      block
      color="primary"
      size="large"
      rounded="lg"
      variant="flat"
      :loading="loading"
      class="font-weight-bold text-none"
      prepend-icon="mdi-openid"
      @click="redirect"
    >
      {{ $t('login.ssoSignIn', { name: displayName }) }}
    </v-btn>
  </div>
</template>

<script lang="ts">
import { getOidcRedirection } from "@/services/auth";
import { defineComponent } from "vue";

export default defineComponent({
  props: {
    name: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      loading: false,
    };
  },
  computed: {
    displayName(): string {
      if (!this.name) return "OIDC";
      return this.name.charAt(0).toUpperCase() + this.name.slice(1);
    },
  },
  methods: {
    /**
     * Perform login.
     * @returns {Promise<void>}
     */
    async redirect() {
      try {
        this.loading = true;
        const next = (this.$route.query.next as string) || undefined;
        const redirection = await getOidcRedirection(this.name, next);
        if (redirection && redirection.url) {
          window.location.href = redirection.url;
        } else {
          throw new Error(
            redirection?.error ||
              (this as any).$t("login.invalidRedirect"),
          );
        }
      } catch (e: any) {
        this.loading = false;
        (this as any).$eventBus?.emit(
          "notify",
          (this as any).$t("login.oidcError", { msg: e.message }),
          "error",
        );
      }
    },
  },
});
</script>

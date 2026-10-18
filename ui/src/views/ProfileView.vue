<template>
  <v-container fluid class="pa-4">
    <!-- Top Card: Profile Header -->
    <v-card class="border mb-4" elevation="0" rounded="lg">
      <v-toolbar color="surface" density="compact" class="px-3 py-1">
        <v-icon icon="mdi-account-circle-outline" class="mr-2 text-primary" size="24"></v-icon>
        <span class="text-subtitle-1 font-weight-bold">{{ $t('nav.myProfile') }}</span>
        <v-spacer></v-spacer>
        <v-btn
          icon="mdi-refresh"
          variant="text"
          size="small"
          @click="loadProfileData"
          :loading="isLoading"
          :title="$t('config.refresh')"
        ></v-btn>
      </v-toolbar>
      <v-card-text class="pt-4 pb-4">
        <v-row align="center">
          <v-col cols="auto">
            <v-avatar color="primary" variant="tonal" size="64" class="text-h5 font-weight-bold">
              {{ profile?.username ? profile.username.charAt(0).toUpperCase() : 'U' }}
            </v-avatar>
          </v-col>
          <v-col>
            <div class="text-h6 font-weight-bold">{{ profile?.username }}</div>
            <div class="d-flex align-center mt-1 flex-wrap ga-2">
              <v-chip
                size="small"
                :color="getRoleColor(profile?.role)"
                variant="flat"
                class="font-weight-bold text-uppercase"
              >
                {{ formatRole(profile?.role) }}
              </v-chip>
              <v-chip
                size="small"
                variant="tonal"
                :prepend-icon="profile?.provider === 'oidc' ? 'mdi-openid' : 'mdi-lock-outline'"
              >
                {{ profile?.provider === 'oidc' ? 'OIDC' : $t('profile.providerLocal') }}
              </v-chip>
              <span class="text-caption text-medium-emphasis ml-2" v-if="profile?.createdAt">
                {{ $t('profile.memberSince', { date: formatDate(profile.createdAt) }) }}
              </span>
            </div>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-row>
      <!-- Left Column: Preferences & Security -->
      <v-col cols="12" md="5">
        <!-- Appearance & Preferences -->
        <v-card class="border mb-4" elevation="0" rounded="lg">
          <v-card-title class="text-subtitle-1 font-weight-bold d-flex align-center">
            <v-icon icon="mdi-palette-outline" class="mr-2 text-primary"></v-icon>
            {{ $t('profile.appearance') }}
          </v-card-title>
          <v-divider></v-divider>
          <v-card-text>
            <div class="text-body-2 font-weight-medium mb-3">{{ $t('profile.themePreference') }}</div>
            <v-radio-group
              v-model="selectedTheme"
              @update:model-value="onThemeChange"
              density="compact"
              hide-details
            >
              <v-radio
                :label="$t('profile.darkTheme')"
                value="dark"
                color="primary"
                class="mb-2"
              ></v-radio>
              <v-radio
                :label="$t('profile.lightTheme')"
                value="light"
                color="primary"
              ></v-radio>
            </v-radio-group>
          </v-card-text>
        </v-card>

        <!-- Password Change (Local users only) -->
        <v-card v-if="profile?.provider === 'local'" class="border mb-4" elevation="0" rounded="lg">
          <v-card-title class="text-subtitle-1 font-weight-bold d-flex align-center">
            <v-icon icon="mdi-shield-lock-outline" class="mr-2 text-primary"></v-icon>
            {{ $t('profile.changePassword') }}
          </v-card-title>
          <v-divider></v-divider>
          <v-card-text>
            <v-form ref="passwordForm" v-model="passwordValid" @submit.prevent="submitPasswordChange">
              <v-text-field
                v-model="currentPassword"
                :label="$t('profile.currentPassword')"
                type="password"
                prepend-inner-icon="mdi-lock-outline"
                variant="outlined"
                density="comfortable"
                :rules="[rules.required]"
                class="mb-2"
              ></v-text-field>

              <v-text-field
                v-model="newPassword"
                :label="$t('profile.newPassword')"
                type="password"
                prepend-inner-icon="mdi-key-outline"
                variant="outlined"
                density="comfortable"
                :rules="[rules.required, rules.minLength]"
                class="mb-2"
              ></v-text-field>

              <v-text-field
                v-model="confirmPassword"
                :label="$t('profile.confirmNewPassword')"
                type="password"
                prepend-inner-icon="mdi-check-circle-outline"
                variant="outlined"
                density="comfortable"
                :rules="[rules.required, rules.matchesNew]"
                class="mb-3"
              ></v-text-field>

              <v-btn
                color="primary"
                variant="flat"
                type="submit"
                :loading="passwordLoading"
                :disabled="!passwordValid"
                class="text-none font-weight-bold"
              >
                {{ $t('profile.updatePassword') }}
              </v-btn>
            </v-form>
          </v-card-text>
        </v-card>
      </v-col>

      <!-- Right Column: API Tokens -->
      <v-col cols="12" md="7">
        <v-card class="border mb-4" elevation="0" rounded="lg">
          <v-toolbar color="surface" density="compact" class="px-3 py-1">
            <v-icon icon="mdi-key-variant" class="mr-2 text-primary"></v-icon>
            <span class="text-subtitle-1 font-weight-bold mr-2">{{ $t('profile.personalTokens') }}</span>
            <v-chip size="small" variant="tonal" color="primary">
              {{ tokens.length }}
            </v-chip>
            <v-spacer></v-spacer>
            <v-btn
              color="primary"
              prepend-icon="mdi-plus"
              size="small"
              rounded="lg"
              class="text-none font-weight-bold"
              @click="openCreateTokenDialog"
            >
              {{ $t('profile.generateToken') }}
            </v-btn>
          </v-toolbar>
          <v-divider></v-divider>

          <v-card-text class="pa-0">
            <div class="px-4 py-2 text-caption text-medium-emphasis">
              {{ $t('profile.tokensHelpPrefix') }}<code>Authorization: Bearer wud_...</code>{{ $t('profile.tokensHelpSuffix') }}
            </div>

            <v-table hover density="comfortable">
              <thead>
                <tr>
                  <th class="text-left font-weight-bold">{{ $t('detail.name') }}</th>
                  <th class="text-left font-weight-bold">{{ $t('profile.scopes') }}</th>
                  <th class="text-left font-weight-bold">{{ $t('detail.created') }}</th>
                  <th class="text-left font-weight-bold">{{ $t('profile.expires') }}</th>
                  <th class="text-left font-weight-bold">{{ $t('profile.lastUsed') }}</th>
                  <th class="text-right font-weight-bold pr-4">{{ $t('profile.revoke') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="tokens.length === 0">
                  <td colspan="6" class="text-center py-6 text-medium-emphasis">
                    <v-icon icon="mdi-key-remove" size="32" class="mb-2 opacity-50"></v-icon>
                    <div>{{ $t('profile.noTokens') }}</div>
                  </td>
                </tr>
                <tr v-for="token in tokens" :key="token.id">
                  <td class="font-weight-medium">{{ token.name }}</td>
                  <td>
                    <div class="d-flex ga-1 flex-wrap">
                      <v-chip
                        v-for="s in token.scopes"
                        :key="s"
                        size="x-small"
                        :color="s === 'write' ? 'warning' : 'info'"
                        variant="tonal"
                        class="text-uppercase font-weight-bold"
                      >
                        {{ s }}
                      </v-chip>
                    </div>
                  </td>
                  <td class="text-caption text-medium-emphasis">{{ formatDate(token.createdAt) }}</td>
                  <td class="text-caption text-medium-emphasis">
                    <span v-if="token.expiresAt">{{ formatDate(token.expiresAt) }}</span>
                    <span v-else class="text-success">{{ $t('profile.never') }}</span>
                  </td>
                  <td class="text-caption text-medium-emphasis">
                    <span v-if="token.lastUsedAt">{{ formatDate(token.lastUsedAt) }}</span>
                    <span v-else>{{ $t('profile.never') }}</span>
                  </td>
                  <td class="text-right pr-4">
                    <v-btn
                      icon="mdi-delete-outline"
                      variant="text"
                      size="small"
                      color="error"
                      :title="$t('profile.revokeToken')"
                      @click="openDeleteTokenDialog(token)"
                    ></v-btn>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Create Token Dialog -->
    <v-dialog v-model="createTokenDialog" max-width="480" persistent>
      <v-card rounded="lg" class="pa-2">
        <v-card-title class="d-flex align-center">
          <v-icon icon="mdi-key-plus" class="mr-2 text-primary"></v-icon>
          {{ $t('profile.generateApiToken') }}
        </v-card-title>
        <v-card-text>
          <v-form ref="createTokenForm" v-model="tokenValid" @submit.prevent="submitCreateToken">
            <v-text-field
              v-model="newToken.name"
              :label="$t('profile.tokenName')"
              :placeholder="$t('profile.tokenNamePlaceholder')"
              prepend-inner-icon="mdi-label-outline"
              variant="outlined"
              density="comfortable"
              :rules="[rules.required]"
              class="mb-2"
              autofocus
            ></v-text-field>

            <div class="text-subtitle-2 font-weight-bold mb-1">{{ $t('profile.permissions') }}</div>
            <v-checkbox
              v-model="newToken.scopes"
              value="read"
              :label="$t('profile.scopeRead')"
              color="primary"
              density="compact"
              hide-details
            ></v-checkbox>
            <v-checkbox
              v-model="newToken.scopes"
              value="write"
              :label="$t('profile.scopeWrite')"
              color="primary"
              density="compact"
              hide-details
              class="mb-3"
            ></v-checkbox>

            <v-select
              v-model="newToken.expiration"
              :items="expirationOptions"
              item-title="title"
              item-value="value"
              :label="$t('profile.expiration')"
              prepend-inner-icon="mdi-clock-outline"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            ></v-select>
          </v-form>
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="createTokenDialog = false">{{ $t('containers.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="tokenActionLoading"
            :disabled="!tokenValid || newToken.scopes.length === 0"
            @click="submitCreateToken"
          >
            {{ $t('profile.generate') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Raw Secret Display Dialog (Shown Once) -->
    <v-dialog v-model="showSecretDialog" max-width="540" persistent>
      <v-card rounded="lg" class="pa-2">
        <v-card-title class="d-flex align-center text-success">
          <v-icon icon="mdi-check-circle" class="mr-2 text-success"></v-icon>
          {{ $t('profile.tokenCreatedTitle') }}
        </v-card-title>
        <v-card-text>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            {{ $t('profile.copyNowPrefix') }}<strong>{{ $t('profile.neverShown') }}</strong>{{ $t('profile.copyNowSuffix') }}
          </v-alert>

          <v-text-field
            :model-value="generatedSecret"
            readonly
            variant="outlined"
            density="comfortable"
            prepend-inner-icon="mdi-key"
            append-inner-icon="mdi-content-copy"
            @click:append-inner="copyTokenToClipboard"
            class="mb-2 font-monospace"
            :hint="$t('profile.copyHint')"
            persistent-hint
          ></v-text-field>
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer></v-spacer>
          <v-btn
            color="primary"
            variant="flat"
            @click="showSecretDialog = false"
          >
            {{ $t('profile.savedToken') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Revoke Token Confirmation Dialog -->
    <v-dialog v-model="deleteTokenDialog" max-width="400">
      <v-card rounded="lg" class="pa-2" v-if="selectedToken">
        <v-card-title class="text-error d-flex align-center">
          <v-icon icon="mdi-alert" class="mr-2 text-error"></v-icon>
          {{ $t('profile.revokeTitle') }}
        </v-card-title>
        <v-card-text>
          {{ $t('profile.revokeConfirmPrefix') }}<strong>{{ selectedToken.name }}</strong>{{ $t('profile.revokeConfirmSuffix') }}
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="deleteTokenDialog = false">{{ $t('containers.cancel') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            :loading="tokenActionLoading"
            @click="submitDeleteToken"
          >
            {{ $t('profile.revoke') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, inject } from 'vue';
import { useTheme } from 'vuetify';
import { useI18n } from 'vue-i18n';
import {
  getProfile,
  updatePreferences,
  updatePassword,
  listTokens,
  createToken,
  deleteToken,
  ApiTokenItem,
} from '@/services/profile';
import { UserItem } from '@/services/user';
import { copyToClipboard } from '@/services/clipboard';

export default defineComponent({
  name: 'ProfileView',
  setup() {
    const theme = useTheme();
    const eventBus = inject('eventBus') as any;
    const { t } = useI18n();

    const profile = ref<UserItem | null>(null);
    const tokens = ref<ApiTokenItem[]>([]);
    const isLoading = ref(false);

    // Preferences
    const selectedTheme = ref<'light' | 'dark'>('dark');

    // Password change
    const passwordValid = ref(false);
    const passwordLoading = ref(false);
    const currentPassword = ref('');
    const newPassword = ref('');
    const confirmPassword = ref('');

    // Token creation & management
    const createTokenDialog = ref(false);
    const tokenValid = ref(false);
    const tokenActionLoading = ref(false);
    const showSecretDialog = ref(false);
    const generatedSecret = ref('');
    const deleteTokenDialog = ref(false);
    const selectedToken = ref<ApiTokenItem | null>(null);

    const newToken = ref<{
      name: string;
      scopes: ('read' | 'write')[];
      expiration: string;
    }>({
      name: '',
      scopes: ['read', 'write'],
      expiration: 'never',
    });

    // Computed so the labels follow the active locale.
    const expirationOptions = computed(() => [
      { title: t('profile.expNever'), value: 'never' },
      { title: t('profile.expDays', { n: 30 }), value: '30d' },
      { title: t('profile.expDays', { n: 90 }), value: '90d' },
      { title: t('profile.exp1y'), value: '1y' },
    ]);

    const rules = computed(() => ({
      required: (v: string) => !!v || t('profile.requiredField'),
      minLength: (v: string) =>
        !v || v.length >= 6 || t('profile.minChars'),
      matchesNew: (v: string) =>
        v === newPassword.value || t('profile.passwordsMismatch'),
    }));

    const notify = (msg: string, level = 'info') => {
      eventBus?.emit('notify', msg, level);
    };

    const getRoleColor = (role?: string) => {
      switch (role) {
        case 'admin':
          return 'error';
        case 'rw':
          return 'primary';
        case 'ro':
        default:
          return 'grey-darken-1';
      }
    };

    const formatRole = (role?: string) => {
      switch (role) {
        case 'admin':
          return t('nav.demoAdmin');
        case 'rw':
          return t('nav.demoRw');
        case 'ro':
        default:
          return t('nav.demoRo');
      }
    };

    const formatDate = (dateStr?: string | null) => {
      if (!dateStr) return 'N/A';
      try {
        return new Date(dateStr).toLocaleString();
      } catch {
        return dateStr;
      }
    };

    const loadProfileData = async () => {
      isLoading.value = true;
      try {
        profile.value = await getProfile();
        if (profile.value?.preferences?.theme) {
          selectedTheme.value = profile.value.preferences.theme;
        } else {
          selectedTheme.value = localStorage.darkMode === 'true' ? 'dark' : 'light';
        }
        tokens.value = await listTokens();
      } catch (e: any) {
        notify(e.message || t('profile.loadError'), 'error');
      } finally {
        isLoading.value = false;
      }
    };

    const onThemeChange = async (val: 'light' | 'dark') => {
      theme.global.name.value = val;
      localStorage.darkMode = String(val === 'dark');
      try {
        await updatePreferences({ theme: val });
        notify(t('profile.themeSaved'), 'success');
      } catch (e: any) {
        notify(e.message || t('profile.themeSaveError'), 'error');
      }
    };

    const submitPasswordChange = async () => {
      if (!currentPassword.value || !newPassword.value) return;
      passwordLoading.value = true;
      try {
        await updatePassword(currentPassword.value, newPassword.value);
        notify(t('profile.passwordUpdated'), 'success');
        currentPassword.value = '';
        newPassword.value = '';
        confirmPassword.value = '';
      } catch (e: any) {
        notify(e.message || t('profile.passwordUpdateError'), 'error');
      } finally {
        passwordLoading.value = false;
      }
    };

    const openCreateTokenDialog = () => {
      newToken.value = {
        name: '',
        scopes: ['read', 'write'],
        expiration: 'never',
      };
      createTokenDialog.value = true;
    };

    const submitCreateToken = async () => {
      if (!newToken.value.name || newToken.value.scopes.length === 0) return;
      tokenActionLoading.value = true;

      let expiresAt: string | null = null;
      const now = new Date();
      if (newToken.value.expiration === '30d') {
        now.setDate(now.getDate() + 30);
        expiresAt = now.toISOString();
      } else if (newToken.value.expiration === '90d') {
        now.setDate(now.getDate() + 90);
        expiresAt = now.toISOString();
      } else if (newToken.value.expiration === '1y') {
        now.setFullYear(now.getFullYear() + 1);
        expiresAt = now.toISOString();
      }

      try {
        const result = await createToken({
          name: newToken.value.name,
          scopes: newToken.value.scopes,
          expiresAt,
        });
        createTokenDialog.value = false;
        generatedSecret.value = result.rawSecret;
        showSecretDialog.value = true;
        tokens.value = await listTokens();
      } catch (e: any) {
        notify(e.message || t('profile.tokenCreateError'), 'error');
      } finally {
        tokenActionLoading.value = false;
      }
    };

    const copyTokenToClipboard = async () => {
      if (!generatedSecret.value) return;
      const copied = await copyToClipboard(generatedSecret.value);
      if (copied) {
        notify(t('profile.tokenCopied'), 'success');
      } else {
        notify(t('profile.copyFailed'), 'warning');
      }
    };

    const openDeleteTokenDialog = (tok: ApiTokenItem) => {
      selectedToken.value = tok;
      deleteTokenDialog.value = true;
    };

    const submitDeleteToken = async () => {
      if (!selectedToken.value) return;
      tokenActionLoading.value = true;
      try {
        await deleteToken(selectedToken.value.id);
        notify(t('profile.tokenRevoked', { name: selectedToken.value.name }), 'success');
        deleteTokenDialog.value = false;
        tokens.value = await listTokens();
      } catch (e: any) {
        notify(e.message || t('profile.tokenRevokeError'), 'error');
      } finally {
        tokenActionLoading.value = false;
      }
    };

    onMounted(loadProfileData);

    return {
      profile,
      tokens,
      isLoading,
      selectedTheme,
      passwordValid,
      passwordLoading,
      currentPassword,
      newPassword,
      confirmPassword,
      createTokenDialog,
      tokenValid,
      tokenActionLoading,
      showSecretDialog,
      generatedSecret,
      deleteTokenDialog,
      selectedToken,
      newToken,
      expirationOptions,
      rules,
      getRoleColor,
      formatRole,
      formatDate,
      loadProfileData,
      onThemeChange,
      submitPasswordChange,
      openCreateTokenDialog,
      submitCreateToken,
      copyTokenToClipboard,
      openDeleteTokenDialog,
      submitDeleteToken,
    };
  },
});
</script>

<style scoped>
.font-monospace input {
  font-family: monospace;
}
</style>

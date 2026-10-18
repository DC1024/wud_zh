<template>
  <v-container fluid class="pa-4">
    <!-- Top Toolbar with Title, Search Filter & Add User Button -->
    <v-card class="border mb-4" elevation="0" rounded="lg">
      <v-toolbar color="surface" density="compact" class="px-3 py-1">
        <v-icon icon="mdi-account-group-outline" class="mr-2 text-primary" size="24"></v-icon>
        <div class="d-flex align-center">
          <span class="text-subtitle-1 font-weight-bold mr-2">{{ $t('users.title') }}</span>
          <v-chip size="small" variant="tonal" color="primary">
            {{ $t('users.count', { n: users.length }) }}
          </v-chip>
        </div>

        <v-spacer></v-spacer>

        <!-- Search Input -->
        <v-text-field
          v-model="search"
          prepend-inner-icon="mdi-magnify"
          :placeholder="$t('users.searchPlaceholder')"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          single-line
          class="mr-2"
          style="max-width: 240px;"
        ></v-text-field>

        <v-btn
          color="primary"
          prepend-icon="mdi-account-plus"
          size="small"
          rounded="lg"
          class="mr-2 text-none font-weight-bold"
          @click="openAddDialog"
        >
          {{ $t('users.add') }}
        </v-btn>

        <v-btn
          icon="mdi-refresh"
          variant="text"
          size="small"
          @click="loadUsers"
          :loading="isLoading"
          :title="$t('config.refresh')"
        ></v-btn>
      </v-toolbar>
    </v-card>

    <!-- Users Table Card -->
    <v-card class="border" elevation="0" rounded="lg">
      <v-table hover density="comfortable">
        <thead>
          <tr>
            <th class="text-left font-weight-bold">{{ $t('users.colUser') }}</th>
            <th class="text-left font-weight-bold">{{ $t('users.colRole') }}</th>
            <th class="text-left font-weight-bold">{{ $t('users.colProvider') }}</th>
            <th class="text-left font-weight-bold">{{ $t('detail.created') }}</th>
            <th class="text-right font-weight-bold pr-4">{{ $t('users.colActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filteredUsers.length === 0">
            <td colspan="5" class="text-center py-6 text-medium-emphasis">
              <v-icon icon="mdi-account-search-outline" size="36" class="mb-2 opacity-50"></v-icon>
              <div>{{ $t('users.none') }}</div>
            </td>
          </tr>
          <tr v-for="user in filteredUsers" :key="user.id">
            <!-- Username with avatar -->
            <td class="py-3">
              <div class="d-flex align-center">
                <v-avatar color="primary" variant="tonal" size="32" class="mr-3 font-weight-bold text-caption">
                  {{ user.username.charAt(0).toUpperCase() }}
                </v-avatar>
                <div>
                  <div class="font-weight-bold">{{ user.username }}</div>
                  <div class="text-caption text-medium-emphasis">{{ $t('users.idLabel', { id: user.id }) }}</div>
                </div>
              </div>
            </td>

            <!-- Role badge -->
            <td>
              <v-chip
                size="small"
                :color="getRoleColor(user.role)"
                variant="flat"
                class="font-weight-bold text-uppercase"
              >
                {{ formatRole(user.role) }}
              </v-chip>
            </td>

            <!-- Provider badge -->
            <td>
              <v-chip
                size="small"
                variant="tonal"
                :prepend-icon="user.provider === 'oidc' ? 'mdi-openid' : 'mdi-lock-outline'"
              >
                {{ user.provider === 'oidc' ? 'OIDC' : $t('profile.providerLocal') }}
              </v-chip>
            </td>

            <!-- Created at -->
            <td class="text-caption text-medium-emphasis">
              {{ formatDate(user.createdAt) }}
            </td>

            <!-- Actions -->
            <td class="text-right pr-4">
              <v-btn
                icon="mdi-pencil-outline"
                variant="text"
                size="small"
                color="primary"
                :title="$t('users.editUser')"
                class="mr-1"
                @click="openEditDialog(user)"
              ></v-btn>
              <v-btn
                icon="mdi-delete-outline"
                variant="text"
                size="small"
                color="error"
                :title="$t('users.deleteUser')"
                :disabled="isCurrentUser(user)"
                @click="openDeleteDialog(user)"
              ></v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <!-- Add User Dialog -->
    <v-dialog v-model="addDialog" max-width="480" persistent>
      <v-card rounded="lg" class="pa-2">
        <v-card-title class="d-flex align-center">
          <v-icon icon="mdi-account-plus" class="mr-2 text-primary"></v-icon>
          {{ $t('users.createTitle') }}
        </v-card-title>
        <v-card-text>
          <v-form ref="addForm" v-model="addValid" @submit.prevent="submitAddUser">
            <v-text-field
              v-model="newUser.username"
              :label="$t('login.username')"
              prepend-inner-icon="mdi-account"
              variant="outlined"
              density="comfortable"
              :rules="[rules.required]"
              class="mb-2"
              autofocus
            ></v-text-field>

            <v-text-field
              v-model="newUser.password"
              :label="$t('login.password')"
              type="password"
              prepend-inner-icon="mdi-lock"
              variant="outlined"
              density="comfortable"
              :rules="[rules.required, rules.minLength]"
              class="mb-2"
            ></v-text-field>

            <v-select
              v-model="newUser.role"
              :items="roleOptions"
              item-title="title"
              item-value="value"
              :label="$t('users.role')"
              prepend-inner-icon="mdi-shield-account"
              variant="outlined"
              density="comfortable"
              class="mb-2"
            >
              <template #item="{ props, item }">
                <v-list-item v-bind="props" :subtitle="item.raw.subtitle"></v-list-item>
              </template>
            </v-select>
          </v-form>
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="addDialog = false">{{ $t('containers.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="actionLoading"
            :disabled="!addValid"
            @click="submitAddUser"
          >
            {{ $t('users.create') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Edit User Dialog -->
    <v-dialog v-model="editDialog" max-width="480" persistent>
      <v-card rounded="lg" class="pa-2" v-if="selectedUser">
        <v-card-title class="d-flex align-center">
          <v-icon icon="mdi-account-edit" class="mr-2 text-primary"></v-icon>
          {{ $t('users.editTitle', { name: selectedUser.username }) }}
        </v-card-title>
        <v-card-text>
          <v-select
            v-model="editUserRole"
            :items="roleOptions"
            item-title="title"
            item-value="value"
            :label="$t('users.role')"
            prepend-inner-icon="mdi-shield-account"
            variant="outlined"
            density="comfortable"
            class="mb-3"
          >
            <template #item="{ props, item }">
              <v-list-item v-bind="props" :subtitle="item.raw.subtitle"></v-list-item>
            </template>
          </v-select>

          <v-alert
            v-if="selectedUser.provider === 'oidc'"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3 text-caption"
          >
            {{ $t('users.oidcNotice') }}
          </v-alert>

          <v-text-field
            v-if="selectedUser.provider === 'local'"
            v-model="editUserPassword"
            :label="$t('users.resetPassword')"
            type="password"
            prepend-inner-icon="mdi-lock-reset"
            variant="outlined"
            density="comfortable"
            :hint="$t('users.resetPasswordHint')"
            persistent-hint
          ></v-text-field>
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="editDialog = false">{{ $t('containers.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="actionLoading"
            @click="submitEditUser"
          >
            {{ $t('users.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card rounded="lg" class="pa-2" v-if="selectedUser">
        <v-card-title class="text-error d-flex align-center">
          <v-icon icon="mdi-alert" class="mr-2 text-error"></v-icon>
          {{ $t('users.deleteTitle') }}
        </v-card-title>
        <v-card-text>
          {{ $t('users.deleteConfirmPrefix') }}<strong>{{ selectedUser.username }}</strong>{{ $t('users.deleteConfirmSuffix') }}
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="deleteDialog = false">{{ $t('containers.cancel') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            :loading="actionLoading"
            @click="submitDeleteUser"
          >
            {{ $t('containers.delete') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { listUsers, createUser, updateUser, deleteUser, UserItem } from '@/services/user';
import { getUser } from '@/services/auth';

export default defineComponent({
  name: 'ConfigurationUsersView',
  setup() {
    const eventBus = inject('eventBus') as any;
    const { t } = useI18n();

    const users = ref<UserItem[]>([]);
    const currentUser = ref<any>(null);
    const search = ref('');
    const isLoading = ref(false);
    const actionLoading = ref(false);

    const addDialog = ref(false);
    const addValid = ref(false);
    const newUser = ref({
      username: '',
      password: '',
      role: 'ro' as 'admin' | 'rw' | 'ro',
    });

    const editDialog = ref(false);
    const selectedUser = ref<UserItem | null>(null);
    const editUserRole = ref<'admin' | 'rw' | 'ro'>('ro');
    const editUserPassword = ref('');

    const deleteDialog = ref(false);

    const roleOptions = computed(() => [
      {
        value: 'admin',
        title: t('users.roleAdmin'),
        subtitle: t('users.roleAdminHint'),
      },
      {
        value: 'rw',
        title: t('users.roleRw'),
        subtitle: t('users.roleRwHint'),
      },
      {
        value: 'ro',
        title: t('users.roleRo'),
        subtitle: t('users.roleRoHint'),
      },
    ]);

    const rules = computed(() => ({
      required: (v: string) => !!v || t('profile.requiredField'),
      minLength: (v: string) =>
        !v || v.length >= 6 || t('profile.minChars'),
    }));

    const filteredUsers = computed(() => {
      if (!search.value) return users.value;
      const q = search.value.toLowerCase();
      return users.value.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          u.role.toLowerCase().includes(q) ||
          u.provider.toLowerCase().includes(q),
      );
    });

    const notify = (msg: string, level = 'info') => {
      eventBus?.emit('notify', msg, level);
    };

    const loadUsers = async () => {
      isLoading.value = true;
      try {
        users.value = await listUsers();
        currentUser.value = await getUser();
      } catch (e: any) {
        notify(e.message || t('users.loadError'), 'error');
      } finally {
        isLoading.value = false;
      }
    };

    const isCurrentUser = (user: UserItem) => {
      return currentUser.value && currentUser.value.id === user.id;
    };

    const getRoleColor = (role: string) => {
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

    const formatRole = (role: string) => {
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

    const openAddDialog = () => {
      newUser.value = { username: '', password: '', role: 'ro' };
      addDialog.value = true;
    };

    const submitAddUser = async () => {
      if (!newUser.value.username || !newUser.value.password) return;
      actionLoading.value = true;
      try {
        await createUser(newUser.value);
        notify(t('users.created', { name: newUser.value.username }), 'success');
        addDialog.value = false;
        await loadUsers();
      } catch (e: any) {
        notify(e.message || t('users.createError'), 'error');
      } finally {
        actionLoading.value = false;
      }
    };

    const openEditDialog = (user: UserItem) => {
      selectedUser.value = user;
      editUserRole.value = user.role;
      editUserPassword.value = '';
      editDialog.value = true;
    };

    const submitEditUser = async () => {
      if (!selectedUser.value) return;
      actionLoading.value = true;
      try {
        const payload: { role?: 'admin' | 'rw' | 'ro'; password?: string } = {
          role: editUserRole.value,
        };
        if (editUserPassword.value) {
          payload.password = editUserPassword.value;
        }
        await updateUser(selectedUser.value.id, payload);
        notify(t('users.updated', { name: selectedUser.value.username }), 'success');
        editDialog.value = false;
        await loadUsers();
      } catch (e: any) {
        notify(e.message || t('users.updateError'), 'error');
      } finally {
        actionLoading.value = false;
      }
    };

    const openDeleteDialog = (user: UserItem) => {
      selectedUser.value = user;
      deleteDialog.value = true;
    };

    const submitDeleteUser = async () => {
      if (!selectedUser.value) return;
      actionLoading.value = true;
      try {
        await deleteUser(selectedUser.value.id);
        notify(t('users.deleted', { name: selectedUser.value.username }), 'success');
        deleteDialog.value = false;
        await loadUsers();
      } catch (e: any) {
        notify(e.message || t('users.deleteError'), 'error');
      } finally {
        actionLoading.value = false;
      }
    };

    onMounted(loadUsers);

    return {
      users,
      search,
      isLoading,
      actionLoading,
      filteredUsers,
      roleOptions,
      rules,
      addDialog,
      addValid,
      newUser,
      editDialog,
      selectedUser,
      editUserRole,
      editUserPassword,
      deleteDialog,
      getRoleColor,
      formatRole,
      formatDate,
      isCurrentUser,
      loadUsers,
      openAddDialog,
      submitAddUser,
      openEditDialog,
      submitEditUser,
      openDeleteDialog,
      submitDeleteUser,
    };
  },
});
</script>

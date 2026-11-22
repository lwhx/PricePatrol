<script setup lang="ts">
import { computed } from 'vue';
import { statusLabels } from '../lib/format';
const props = defineProps<{ value: string }>();
const tone = computed(() => ['success', 'ok', 'valid', 'verified', 'resolved', 'sent', 'accepted', 'active'].includes(props.value) ? 'success' : ['failed', 'error', 'invalid', 'auth_required'].includes(props.value) ? 'danger' : ['partial', 'pending', 'stale', 'backend_only', 'recoverable'].includes(props.value) ? 'warning' : ['running', 'confirmed', 'queued'].includes(props.value) ? 'primary' : 'info');
</script><template><el-tag :type="tone" effect="light" size="small" round>{{ statusLabels[value] || value || '未知' }}</el-tag></template>

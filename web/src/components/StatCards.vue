<script setup lang="ts">defineProps<{ items: { label: string; value: string | number; hint?: string; tone?: string }[] }>();</script>
<template><div class="stats-grid"><article v-for="item in items" :key="item.label" class="stat-card"><span>{{ item.label }}</span><strong :class="item.tone">{{ item.value }}</strong><small v-if="item.hint">{{ item.hint }}</small></article></div></template>

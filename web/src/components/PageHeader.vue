<script setup lang="ts">defineProps<{ title: string; description?: string; eyebrow?: string }>();</script>
<template><header class="page-header"><div><div class="eyebrow">{{ eyebrow || 'PRICE MONITOR' }}</div><h1>{{ title }}</h1><p v-if="description">{{ description }}</p></div><div class="header-actions"><slot /></div></header></template>

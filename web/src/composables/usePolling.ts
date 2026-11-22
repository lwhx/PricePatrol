import { onMounted, onUnmounted, onActivated, onDeactivated } from 'vue';
export function usePolling(load: () => unknown, interval = 10000) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => { if (!timer) { void load(); timer = setInterval(() => { if (!document.hidden) void load(); }, interval); } };
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  onMounted(start); onActivated(start); onDeactivated(stop); onUnmounted(stop);
}

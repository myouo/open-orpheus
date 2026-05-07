<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { getBridge } from "$lib/bridge";
  import type { ManageContract } from "$bridge/contracts/manage-api";

  const api = getBridge<ManageContract>("manage");

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** i).toFixed(2)} ${units[i]}`;
  }

  let statsPromise = $state(api.cache.getStats());
  let clearing = $state<
    Parameters<ManageContract["cache"]["clearResources"]>[0] | null
  >(null);

  async function clearResources(
    category: Parameters<ManageContract["cache"]["clearResources"]>[0]
  ) {
    clearing = category;
    try {
      await api.cache.clearResources(category);
    } finally {
      clearing = null;
      statsPromise = api.cache.getStats();
    }
  }

  async function clearCache() {
    await clearResources("http");
    await clearResources("lyrics");
  }
</script>

<h1 class="text-2xl font-bold">本地资源</h1>
<p class="mt-2 text-gray-700">
  Open Orpheus
  日常使用时会产生一些本地资源，如歌曲、歌词和封面等资源的缓存和播放器样式。你可以在这里查看和管理这些本地资源。
</p>

{#await statsPromise}
  <p class="mt-4 text-gray-500">正在加载本地资源信息…</p>
{:then stats}
  <h2 class="mt-2 text-xl font-bold">缓存</h2>
  <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
    <div class="rounded-lg border p-4">
      <h2 class="font-semibold">播放缓存</h2>
      <p class="mt-1 text-sm text-gray-600">{stats.play.entryCount} 首</p>
      <p class="text-sm text-gray-600">{formatBytes(stats.play.sizeBytes)}</p>
      <p class="text-xs text-gray-600">播放缓存请在网易云音乐设置中管理</p>
    </div>
    <div class="rounded-lg border p-4">
      <h2 class="font-semibold">HTTP（图片）缓存</h2>
      <p class="mt-1 text-sm text-gray-600">{stats.http.entryCount} 个条目</p>
      <p class="text-sm text-gray-600">{formatBytes(stats.http.sizeBytes)}</p>
      <Button
        class="mt-3"
        variant="outline"
        size="sm"
        disabled={clearing !== null}
        onclick={() => clearResources("http")}
        >{clearing === "http" ? "清除中…" : "清除"}</Button
      >
    </div>
    <div class="rounded-lg border p-4">
      <h2 class="font-semibold">歌词缓存</h2>
      <p class="mt-1 text-sm text-gray-600">{stats.lyrics.entryCount} 首</p>
      <p class="text-sm text-gray-600">{formatBytes(stats.lyrics.sizeBytes)}</p>
      <Button
        class="mt-3"
        variant="outline"
        size="sm"
        disabled={clearing !== null}
        onclick={() => clearResources("lyrics")}
        >{clearing === "lyrics" ? "清除中…" : "清除"}</Button
      >
    </div>
  </div>
  <div class="text-right">
    <Button
      class="mt-4 w-full sm:w-auto"
      variant="destructive"
      disabled={clearing !== null}
      onclick={clearCache}
      >{clearing !== null ? "清除中…" : "清除所有可清除的缓存"}</Button
    >
  </div>

  <h2 class="mt-2 text-xl font-bold">数据</h2>
  <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
    <div class="rounded-lg border p-4">
      <h2 class="font-semibold">播放器样式</h2>
      <p class="text-sm text-gray-600">{formatBytes(stats.wasm.sizeBytes)}</p>
      <Button
        class="mt-3"
        variant="outline"
        size="sm"
        disabled={clearing !== null}
        onclick={() => clearResources("wasm")}
        >{clearing === "http" ? "清除中…" : "清除"}</Button
      >
    </div>
  </div>
{:catch}
  <p class="mt-4 text-red-500">获取本地资源信息失败。</p>
{/await}

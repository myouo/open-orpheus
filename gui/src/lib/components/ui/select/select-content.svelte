<script lang="ts">
  import { Select as SelectPrimitive } from "bits-ui";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
  import type { Snippet } from "svelte";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    sideOffset = 4,
    children,
    ...restProps
  }: WithoutChildrenOrChild<SelectPrimitive.ContentProps> & {
    children?: Snippet;
    sideOffset?: number;
  } = $props();
</script>

<SelectPrimitive.Content bind:ref {sideOffset} {...restProps}>
  {#snippet child({ props, wrapperProps })}
    <div {...wrapperProps}>
      <div
        {...props}
        data-slot="select-content"
        class={cn(
          "relative z-50 max-h-96 w-[var(--bits-select-anchor-width)] min-w-[8rem] min-w-[var(--bits-select-anchor-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
      >
        <SelectPrimitive.ScrollUpButton
          class="flex cursor-default items-center justify-center py-1"
        >
          <ChevronUpIcon class="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport class="max-h-96 p-1">
          {@render children?.()}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton
          class="flex cursor-default items-center justify-center py-1"
        >
          <ChevronDownIcon class="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </div>
    </div>
  {/snippet}
</SelectPrimitive.Content>

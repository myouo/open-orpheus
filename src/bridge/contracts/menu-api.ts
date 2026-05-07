import type { MenuSkin } from "../../main/menu/types";

export type { MenuSkin } from "../../main/menu/types";

export interface MenuPullResult {
  items: unknown[];
  templates: Record<string, string>;
  colors: MenuSkin;
  cursorX?: number;
  cursorY?: number;
}

export interface MenuContract {
  wayland: boolean;
  submenu: boolean;

  events: {
    show(
      callback: (
        items: unknown[],
        templates: Record<string, string>,
        cursorX: number,
        cursorY: number,
        colors: MenuSkin
      ) => void
    ): void;
    update(callback: (items: unknown[]) => void): void;
  };

  pull(): Promise<MenuPullResult>;
  reportSize(width: number, height: number): Promise<void>;
  itemClick(menuId: string | null): Promise<void>;
  btnClick(btnId: string): Promise<void>;
  close(): Promise<void>;
  openSubmenu(
    items: unknown[],
    templates: Record<string, string>,
    x: number,
    y: number
  ): Promise<void>;
  closeSubmenu(): Promise<void>;
}

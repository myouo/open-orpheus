import { exposeApi } from "../bridge/preload";

exposeApi("desktopLyrics", {
  platform: process.platform,
});

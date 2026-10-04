import "dotenv/config";
import {
  isProduction,
  appIdSetting,
  appSecretSetting,
  databaseUrlSetting,
} from "../autorotate/appSettings";

// ── Boot-time environment surface ───────────────────────────────────
// Infisical SOT (2026-10-03): app-level settings live in the Autorotate
// Infisical project and are served from an in-memory cache (see
// api/autorotate/appSettings.ts and INFISICAL.md).  This module is the thin
// compatibility surface over that cache for values the server needs early.
//
// `isProduction` still reads process.env synchronously: NODE_ENV is
// deployment bootstrap (like PORT and INFISICAL_CLIENT_ID/SECRET), not an
// app-level setting.  Every other value below is a memory-only cache read —
// initAppSettings() must have run at boot before anything touches them.

export const env = {
  get appId(): string {
    return appIdSetting();
  },
  get appSecret(): string {
    return appSecretSetting();
  },
  get isProduction(): boolean {
    return isProduction();
  },
  get databaseUrl(): string {
    return databaseUrlSetting();
  },
};

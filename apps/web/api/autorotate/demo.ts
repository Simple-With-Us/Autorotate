// Demo-mode switch (AR-03).  Simulation is opt-in and explicit: demo mode is
// ON only when AUTOROTATE_DEMO is exactly "1" or "true".  Unset, empty, "0",
// "false" or anything else means real mode, so a production deploy that
// forgets the variable fails closed instead of silently faking every
// rotation.  The marketing sandbox must set AUTOROTATE_DEMO=1 explicitly.
// Read from the Infisical settings cache (memory-only) — see appSettings.
import { isDemoModeSetting } from "./appSettings";

export function isDemoMode(): boolean {
  return isDemoModeSetting();
}

/** Prefix every simulated step message with [demo] (hard requirement). */
export function demoMessage(message: string): string {
  return `[demo] ${message}`;
}

/** Simulate realistic network latency for demo operations. */
export async function demoLatency(minMs = 80, maxMs = 400): Promise<number> {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ms;
}

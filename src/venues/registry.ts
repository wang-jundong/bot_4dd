import type { ParsedTargetTransaction, VenueAdapter } from "./types.js";
export class VenueRegistry {
  constructor(private readonly adapters: readonly VenueAdapter[]) {}
  resolve(tx: ParsedTargetTransaction): VenueAdapter | undefined { return this.adapters.find(a => a.canHandle(tx)); }
}

import type { ProviderAdapter } from "./ProviderAdapter.ts";
import { EcbProviderAdapter } from "./ecb/EcbProviderAdapter.ts";
import { FredProviderAdapter } from "./fred/FredProviderAdapter.ts";
import { YahooChartProviderAdapter } from "./yahoo/YahooChartProviderAdapter.ts";

/** Registry deliberately owns plugin instances; coordinators only resolve IDs. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`PROVIDER_ADAPTER_NOT_REGISTERED:${id}`);
    return adapter;
  }
}

export const productionProviderRegistry = new ProviderRegistry()
  .register(new YahooChartProviderAdapter())
  .register(new EcbProviderAdapter())
  .register(new FredProviderAdapter());

/** فهرس المحوّلات: مزود واحد → محوّل واحد */
import type { ProviderId } from "@/lib/models";
import { cometapiAdapter } from "@/lib/providers/cometapi";
import { kieAdapter } from "@/lib/providers/kie";
import type { ProviderAdapter } from "@/lib/providers/types";

export function getAdapter(provider: ProviderId): ProviderAdapter {
  switch (provider) {
    case "kie":
      return kieAdapter;
    case "cometapi":
      return cometapiAdapter;
    default: {
      const never: never = provider;
      throw new Error(`لا يوجد محوّل للمزود: ${String(never)}`);
    }
  }
}

export type { ProviderAdapter, ProviderKey } from "@/lib/providers/types";

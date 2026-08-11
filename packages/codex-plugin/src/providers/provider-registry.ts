import {
  providerDescriptorSchema,
  type ProviderDescriptor,
} from "../contracts/providers.js";
import type { ProjectManagementProvider } from "../projects/project-management-provider.js";
import type { WorkItemDetailProvider } from "../work-items/work-item-detail-provider.js";
import type { WorkItemProvider } from "../work-items/work-item-provider.js";
import type { ProviderAuthService } from "./provider-auth-service.js";
import type { ProviderLoginDriver } from "./provider-login-driver.js";

export interface ProviderRegistration {
  id: string;
  displayName: string;
  loginMode: "personal_token" | "device_code";
  auth: ProviderAuthService;
  login?: ProviderLoginDriver;
  workItems: WorkItemProvider;
  projects?: ProjectManagementProvider;
  details?: WorkItemDetailProvider;
}

export type ProviderRegistryErrorCode =
  | "provider_already_registered"
  | "provider_not_registered";

export class ProviderRegistryError extends Error {
  constructor(readonly code: ProviderRegistryErrorCode) {
    super(code);
    this.name = "ProviderRegistryError";
  }
}

export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  constructor(registrations: readonly ProviderRegistration[] = []) {
    for (const registration of registrations) {
      if (this.registrations.has(registration.id)) {
        throw new ProviderRegistryError("provider_already_registered");
      }
      this.registrations.set(registration.id, registration);
    }
  }

  has(id: string): boolean {
    return this.registrations.has(id);
  }

  ids(): string[] {
    return [...this.registrations.keys()];
  }

  get(id: string): ProviderRegistration {
    const registration = this.registrations.get(id);
    if (!registration) throw new ProviderRegistryError("provider_not_registered");
    return registration;
  }

  async list(): Promise<ProviderDescriptor[]> {
    return Promise.all([...this.registrations.values()].map(async (registration) =>
      providerDescriptorSchema.parse({
        providerId: registration.id,
        displayName: registration.displayName,
        loginMode: registration.loginMode,
        connection: await registration.auth.getConnection(),
        capabilities: {
          projects: registration.projects !== undefined,
          details: registration.details !== undefined,
        },
      })));
  }
}

export interface Choice {
  value: string;
  label?: string;
}
export interface RegistrationEventMapping {
  signup: string;
  account: Choice;
  class?: Choice | null;
}
export interface RegistrationMappingV2 {
  version: 2;
  default: { account: Choice | null; class?: Choice | null };
  events: RegistrationEventMapping[];
}

/** Only the v2 shape counts. `settingRegistrationData` also holds the dead Stripe-era array. */
export const readRegistrationMapping = (raw: any): RegistrationMappingV2 | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 2) return null;
  return {
    version: 2,
    default: {
      account: raw.default?.account?.value ? raw.default.account : null,
      class: raw.default?.class?.value ? raw.default.class : null,
    },
    events: (Array.isArray(raw.events) ? raw.events : []).filter((e: any) => e?.signup && e?.account?.value),
  };
};

const norm = (s: string) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

export const accountForSignup = (
  mapping: RegistrationMappingV2,
  signup: string,
): { accountRef: string; classRef?: string; via: 'event' | 'default' } | null => {
  const hit = mapping.events.find((e) => norm(e.signup) === norm(signup));
  if (hit) return { accountRef: hit.account.value, classRef: hit.class?.value || undefined, via: 'event' };
  if (mapping.default.account?.value) {
    return {
      accountRef: mapping.default.account.value,
      classRef: mapping.default.class?.value || undefined,
      via: 'default',
    };
  }
  return null;
};

/**
 * The Stripe-era registration list the old sync code reads, or [] once the setting holds the v2
 * mapping above. Without this, every `.find` / `.filter` on it throws for a church that has saved
 * its event accounts on the new Registration tab.
 */
export const legacyRegistrationList = (raw: unknown): any[] => (Array.isArray(raw) ? raw : []);

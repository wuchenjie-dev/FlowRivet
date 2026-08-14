export interface CreatedSyncType {
  projectKey: string;
  typeKey: string;
}

declare const commitTokenBrand: unique symbol;
export type CreatedSyncCommitToken = Readonly<{ readonly [commitTokenBrand]: true }>;

export interface AutomaticCreatedSyncBatch {
  readonly mode: "automatic";
  readonly selected: ReadonlyArray<Readonly<CreatedSyncType>>;
  readonly commitToken: CreatedSyncCommitToken;
}

export interface ManualCreatedSyncBatch {
  readonly mode: "manual";
  readonly selected: ReadonlyArray<Readonly<CreatedSyncType>>;
}

export type CreatedSyncBatch = AutomaticCreatedSyncBatch | ManualCreatedSyncBatch;

export type CreatedSyncSelection = {
  readonly identityKey: string;
  readonly types: readonly CreatedSyncType[];
} & (
  | { readonly mode: "automatic" }
  | { readonly mode: "manual" }
);

interface CursorState {
  readonly lastIdentity: string | undefined;
  readonly revision: number;
}

interface CommitRecord {
  readonly identityKey: string;
  readonly expectedRevision: number;
  readonly lastSelectedIdentity: string | undefined;
}

interface StableType {
  readonly identity: string;
  readonly entry: Readonly<CreatedSyncType>;
}

export class CreatedSyncScheduler {
  readonly #automaticLimit: number;
  readonly #cursors = new Map<string, CursorState>();
  readonly #commits = new WeakMap<CreatedSyncCommitToken, CommitRecord>();
  readonly #usedCommits = new WeakSet<CreatedSyncCommitToken>();

  constructor(options: { automaticLimit: number }) {
    if (!Number.isInteger(options.automaticLimit) || options.automaticLimit <= 0) {
      throw new RangeError("automaticLimit must be a positive integer");
    }
    this.#automaticLimit = options.automaticLimit;
  }

  select(input: CreatedSyncSelection & { readonly mode: "automatic" }): AutomaticCreatedSyncBatch;
  select(input: CreatedSyncSelection & { readonly mode: "manual" }): ManualCreatedSyncBatch;
  select(input: CreatedSyncSelection): CreatedSyncBatch {
    const stableTypes = normalizeTypes(input.types);
    if (input.mode === "manual") {
      return Object.freeze({
        mode: "manual" as const,
        selected: freezeEntries(stableTypes),
      });
    }

    const cursor = this.#cursors.get(input.identityKey) ?? {
      lastIdentity: undefined,
      revision: 0,
    };
    const start = successorIndex(stableTypes, cursor.lastIdentity);
    const selectedTypes = stableTypes.slice(start, start + this.#automaticLimit);
    const commitToken = Object.freeze({}) as CreatedSyncCommitToken;
    this.#commits.set(commitToken, {
      identityKey: input.identityKey,
      expectedRevision: cursor.revision,
      lastSelectedIdentity: selectedTypes.at(-1)?.identity,
    });

    return Object.freeze({
      mode: "automatic" as const,
      selected: freezeEntries(selectedTypes),
      commitToken,
    });
  }

  commit(commitToken: CreatedSyncCommitToken): void {
    const record = this.#commits.get(commitToken);
    if (!record) throw new Error("commit token is invalid");
    if (this.#usedCommits.has(commitToken)) {
      throw new Error("commit token has already been used");
    }

    const cursor = this.#cursors.get(record.identityKey) ?? {
      lastIdentity: undefined,
      revision: 0,
    };
    if (cursor.revision !== record.expectedRevision) {
      throw new Error("commit token is stale");
    }

    this.#usedCommits.add(commitToken);
    this.#cursors.set(record.identityKey, {
      lastIdentity: record.lastSelectedIdentity ?? cursor.lastIdentity,
      revision: cursor.revision + 1,
    });
  }
}

function stableIdentity(entry: CreatedSyncType): string {
  return JSON.stringify([entry.projectKey, entry.typeKey]);
}

function normalizeTypes(types: readonly CreatedSyncType[]): StableType[] {
  const unique = new Map<string, StableType>();
  for (const source of types) {
    const entry = Object.freeze({ projectKey: source.projectKey, typeKey: source.typeKey });
    const identity = stableIdentity(entry);
    if (!unique.has(identity)) unique.set(identity, { identity, entry });
  }
  return [...unique.values()].sort((left, right) =>
    left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
}

function successorIndex(types: readonly StableType[], lastIdentity: string | undefined): number {
  if (lastIdentity === undefined) return 0;
  const index = types.findIndex(({ identity }) => identity > lastIdentity);
  return index === -1 ? 0 : index;
}

function freezeEntries(types: readonly StableType[]): ReadonlyArray<Readonly<CreatedSyncType>> {
  return Object.freeze(types.map(({ entry }) => entry));
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface TapdToken {
  accessToken: string;
  expiresIn: number;
  resource: { type: "workspace"; workspaceId: string };
  scope?: string;
}

interface Transaction {
  id: string;
  state: string;
  callbackUri: string;
  codeChallenge: string;
  expectedWorkspaceId?: string;
  expiresAt: number;
  token?: TapdToken;
  redeemed: boolean;
}

export class OAuthTransactions {
  private readonly transactions = new Map<string, Transaction>();
  private readonly states = new Map<string, string>();
  private readonly allowedCallbacks: Set<string>;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: {
    allowedCallbacks: string[];
    now?: () => number;
    ttlMs?: number;
  }) {
    this.allowedCallbacks = new Set(options.allowedCallbacks);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300_000;
  }

  create(input: {
    callbackUri: string;
    codeChallenge: string;
    expectedWorkspaceId?: string;
  }) {
    this.purgeExpired();
    if (!this.allowedCallbacks.has(input.callbackUri)) {
      throw new Error("callback URI is not allowed");
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) {
      throw new Error("invalid PKCE code challenge");
    }

    const transaction: Transaction = {
      id: randomBytes(24).toString("base64url"),
      state: randomBytes(32).toString("base64url"),
      callbackUri: input.callbackUri,
      codeChallenge: input.codeChallenge,
      expectedWorkspaceId: input.expectedWorkspaceId,
      expiresAt: this.now() + this.ttlMs,
      redeemed: false,
    };
    this.transactions.set(transaction.id, transaction);
    this.states.set(transaction.state, transaction.id);
    return { id: transaction.id, state: transaction.state, expiresAt: transaction.expiresAt };
  }

  getByState(state: string) {
    const transaction = this.findByState(state);
    this.assertActive(transaction);
    return { id: transaction.id, callbackUri: transaction.callbackUri };
  }

  complete(state: string, token: TapdToken) {
    const transaction = this.findByState(state);
    this.assertActive(transaction);
    if (transaction.token) throw new Error("authorization code already used");
    if (
      transaction.expectedWorkspaceId &&
      token.resource.workspaceId !== transaction.expectedWorkspaceId
    ) {
      throw new Error("OAuth resource does not match the expected workspace");
    }
    transaction.token = token;
    this.states.delete(state);
  }

  redeem(id: string, verifier: string) {
    const transaction = this.transactions.get(id);
    if (!transaction) throw new Error("unknown transaction");
    this.assertActive(transaction);
    if (transaction.redeemed) throw new Error("transaction already redeemed");
    if (!transaction.token) throw new Error("authorization is not ready");

    const actual = createHash("sha256").update(verifier).digest("base64url");
    const expectedBuffer = Buffer.from(transaction.codeChallenge);
    const actualBuffer = Buffer.from(actual);
    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new Error("invalid transaction proof");
    }

    transaction.redeemed = true;
    const token = transaction.token;
    transaction.token = undefined;
    return token;
  }

  private findByState(state: string) {
    const id = this.states.get(state);
    const transaction = id ? this.transactions.get(id) : undefined;
    if (!transaction) throw new Error("invalid OAuth state");
    return transaction;
  }

  private assertActive(transaction: Transaction) {
    if (this.now() > transaction.expiresAt) {
      transaction.token = undefined;
      this.transactions.delete(transaction.id);
      this.states.delete(transaction.state);
      throw new Error("OAuth transaction expired");
    }
  }

  private purgeExpired() {
    for (const transaction of this.transactions.values()) {
      if (this.now() > transaction.expiresAt) {
        transaction.token = undefined;
        this.transactions.delete(transaction.id);
        this.states.delete(transaction.state);
      }
    }
  }
}

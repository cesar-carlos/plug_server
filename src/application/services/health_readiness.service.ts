export interface DatabaseReadinessProbe {
  probe(timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface HealthReadinessResult {
  readonly ready: boolean;
  readonly checks: {
    readonly envLoaded: true;
    readonly database: boolean;
    readonly databaseError?: string;
  };
}

export class HealthReadinessService {
  constructor(
    private readonly databaseProbe: DatabaseReadinessProbe,
    private readonly options: {
      readonly databaseTimeoutMs: number;
      readonly skipDatabaseProbe: boolean;
    },
  ) {}

  async check(): Promise<HealthReadinessResult> {
    if (this.options.skipDatabaseProbe) {
      return {
        ready: true,
        checks: {
          envLoaded: true,
          database: true,
        },
      };
    }

    const database = await this.databaseProbe.probe(this.options.databaseTimeoutMs);
    return {
      ready: database.ok,
      checks: {
        envLoaded: true,
        database: database.ok,
        ...(database.ok ? {} : { databaseError: database.error }),
      },
    };
  }
}

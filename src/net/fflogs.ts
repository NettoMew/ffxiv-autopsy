import type { Config } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import type { JobKey, Report } from "../core/types.ts";
import { buildPhaseWindows } from "../domain/phases.ts";
import { Cache } from "./cache.ts";
import { HttpClient } from "./http.ts";

interface RawPhase {
  readonly id: number;
  readonly startTime: number;
}

interface RawFight {
  readonly id: number;
  readonly boss: number;
  readonly name: string;
  readonly start_time: number;
  readonly end_time: number;
  readonly combatTime?: number;
  readonly zoneName?: string;
  readonly kill?: boolean;
  readonly phases?: readonly RawPhase[];
}

interface RawPhaseMeta {
  readonly boss: number;
  readonly phases: readonly string[];
}

interface RawFightsResponse {
  readonly fights: readonly RawFight[];
  readonly phases?: readonly RawPhaseMeta[];
  readonly title?: string;
  readonly owner?: string;
  readonly zone?: number;
  readonly start?: number;
}

export interface TableEntry {
  readonly name: string;
  readonly type: JobKey;
  readonly total: number;
  readonly totalRDPS?: number;
  readonly totalNDPS?: number;
  readonly totalCDPS?: number;
}

export interface TableResponse {
  readonly entries: readonly TableEntry[];
  /** 计入战斗的毫秒数，是官方数值的唯一正确除数。 */
  readonly combatTime: number;
}

/** 非玩家条目，不参与评分。 */
const NON_PLAYER: ReadonlySet<string> = new Set(["LimitBreak", "NPC", "Pet", "Boss"]);

export class FfLogsApi {
  readonly #config: Config;
  readonly #http: HttpClient;
  readonly #cache: Cache;
  #limit: number | null = null;
  #remaining: number | null = null;

  constructor(config: Config, options: { refresh?: boolean } = {}) {
    this.#config = config;
    this.#http = new HttpClient({ minIntervalMs: 120 });
    this.#cache = new Cache("v1", options.refresh !== true);
  }

  /** 释放底层连接，否则进程不会自然退出。 */
  close(): void {
    this.#http.close();
  }

  /** 最近一次响应报告的配额，用于在输出里交代成本。 */
  get budget(): { limit: number | null; remaining: number | null } {
    return { limit: this.#limit, remaining: this.#remaining };
  }

  async report(code: string): Promise<Report> {
    const raw = await this.#get<RawFightsResponse>(`/v1/report/fights/${encodeURIComponent(code)}`, {});
    const names = raw.phases?.[0]?.phases ?? [];

    const fights = raw.fights
      .filter((fight) => fight.boss > 0)
      .map((fight) => ({
        id: fight.id,
        encounterId: fight.boss,
        name: fight.name,
        start: fight.start_time,
        end: fight.end_time,
        combatTime: fight.combatTime ?? fight.end_time - fight.start_time,
        kill: fight.kill === true,
        phases: buildPhaseWindows(fight.phases ?? [], fight.end_time, fight.kill === true, names),
      }));

    if (fights.length === 0) fail(`报告 ${code} 里没有可评分的战斗。`);

    return {
      code,
      title: raw.title ?? code,
      zoneName: raw.fights.find((fight) => fight.zoneName)?.zoneName ?? "",
      owner: raw.owner ?? "未知",
      zoneId: raw.zone ?? 0,
      start: raw.start ?? 0,
      fights,
    };
  }

  async table(view: string, code: string, start: number, end: number): Promise<TableResponse> {
    const raw = await this.#get<{ entries?: readonly TableEntry[]; combatTime?: number; totalTime?: number }>(
      `/v1/report/tables/${view}/${encodeURIComponent(code)}`,
      { start: String(start), end: String(end) },
    );

    return {
      entries: (raw.entries ?? []).filter((entry) => !NON_PLAYER.has(entry.type)),
      combatTime: raw.combatTime ?? raw.totalTime ?? end - start,
    };
  }

  async #get<T>(path: string, query: Readonly<Record<string, string>>): Promise<T> {
    const url = new URL(`https://${this.#config.host}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const cacheKey = url.toString();
    url.searchParams.set("api_key", this.#config.apiKey);

    const cached = this.#cache.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as T;

    const response = await this.#http.request(url.toString());
    this.#recordBudget(response.headers);

    if (response.status !== 200) {
      const detail = readError(response.body);
      fail(`FF Logs 接口返回 ${response.status}${detail ? `：${detail}` : ""}`, `请求：${path}`);
    }

    this.#cache.set(cacheKey, response.body);
    return JSON.parse(response.body) as T;
  }

  #recordBudget(headers: Headers): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(limit)) this.#limit = limit;
    if (Number.isFinite(remaining)) this.#remaining = remaining;
  }
}

function readError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

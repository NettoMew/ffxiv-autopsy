import type { Config } from "../core/config.ts";
import { fail } from "../core/errors.ts";
import { METRICS, type JobCurve, type JobKey, type Metric, type Quantile, type Window } from "../core/types.ts";
import { Cache } from "./cache.ts";
import { HttpClient } from "./http.ts";
import { parseBars, parseDefaults, parseSpreads, type ZoneDefaults } from "./statistics-page.ts";

/**
 * 副本统计页的数据源。
 *
 * 页面把每个职业的整条分位曲线内联在图表脚本里，一次请求就能拿全部职业，
 * 所以建立一个副本的完整基准只要几十次请求，而不是几千次。
 *
 * 阶段编码在 partition 上：partition = 版本分区 + 阶段 * 1000，与页面自身的做法一致。
 */

export type { ZoneDefaults };

export interface CurveRequest {
  readonly zoneId: number;
  readonly encounterId: number;
  readonly metric: Metric;
  readonly window: Window;
  readonly phase: number;
}

const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const XHR_ACCEPT = "text/html, */*; q=0.01";

/** 需要额外单独取一次的分位；其余分位都藏在 1000 号数据集里。 */
const EXTRA_QUANTILES = [0, 10, 90] as const;

export class StatisticsSource {
  readonly #config: Config;
  readonly #http: HttpClient;
  readonly #cache: Cache;
  #session = false;

  constructor(config: Config, options: { refresh?: boolean } = {}) {
    this.#config = config;
    this.#http = new HttpClient({ minIntervalMs: 700 });
    this.#cache = new Cache("statistics", options.refresh !== true);
  }

  /** 释放临时会话文件。 */
  close(): void {
    this.#http.close();
  }

  /** 读取页面自带的默认分区与难度，避免把版本号写死在代码里。 */
  async defaults(zoneId: number, encounterId: number): Promise<ZoneDefaults> {
    const defaults = parseDefaults(await this.#page(zoneId, encounterId, 0));
    if (!defaults) fail("无法从统计页读出默认分区与难度。", "页面结构可能已经改版。");
    return defaults;
  }

  /** 取一个阶段里全部职业的分位曲线。 */
  async curves(request: CurveRequest, defaults: ZoneDefaults): Promise<Record<JobKey, JobCurve>> {
    const spreads = parseSpreads(await this.#table(request, defaults, 1000));
    if (spreads.size === 0) return {};

    const extras = new Map<number, Map<JobKey, number>>();
    for (const quantile of EXTRA_QUANTILES) {
      extras.set(quantile, parseBars(await this.#table(request, defaults, quantile)));
    }

    const curves: Record<JobKey, JobCurve> = {};

    for (const [job, spread] of spreads) {
      const points: Quantile[] = [
        { q: 0, value: extras.get(0)?.get(job) ?? spread.q25 },
        { q: 10, value: extras.get(10)?.get(job) ?? spread.q25 },
        { q: 25, value: spread.q25 },
        { q: 50, value: spread.q50 },
        { q: 75, value: spread.q75 },
        { q: 90, value: extras.get(90)?.get(job) ?? spread.q75 },
        { q: 95, value: spread.q95 },
        { q: 99, value: spread.q99 },
        { q: 100, value: spread.max },
      ];

      curves[job] = { job, label: spread.label, sampleSize: spread.sampleSize, points: monotonic(points) };
    }

    return curves;
  }

  async #table(request: CurveRequest, defaults: ZoneDefaults, dataset: number): Promise<string> {
    const spec = METRICS[request.metric];
    const segments = [
      request.zoneId,
      spec.statistic,
      request.encounterId,
      defaults.difficulty,
      defaults.size,
      defaults.partition + request.phase * 1000,
      dataset,
      1,
      request.window,
      0,
      "Any",
      "Any",
      "All",
      0,
      "normalized",
      "single",
      0,
      -1,
    ];

    const url =
      `https://${this.#config.host}/zone/statistics/table/${segments.join("/")}/` +
      `?keystone=15&dpstype=${spec.dpsType}`;

    const cached = this.#cache.get(url);
    if (cached !== null) return cached;

    await this.#ensureSession(request.zoneId, request.encounterId, request.phase);

    const response = await this.#http.request(url, {
      headers: {
        Accept: XHR_ACCEPT,
        "X-Requested-With": "XMLHttpRequest",
        Referer: this.#pageUrl(request.zoneId, request.encounterId, request.phase),
      },
    });

    if (response.status !== 200) fail(`统计页返回 ${response.status}。`, `请求：${url}`);
    if (response.body.includes("Use the API")) {
      fail("统计页拒绝了本次请求。", "站方会对来路不明的请求返回提示。请稍后重试；若持续失败，说明页面策略已变。");
    }

    this.#cache.set(url, response.body);
    return response.body;
  }

  /** 首次访问需要通过一次无验证码的人机确认，通过之后同一会话内一直有效。 */
  async #ensureSession(zoneId: number, encounterId: number, phase: number): Promise<void> {
    if (this.#session) return;
    this.#session = true;

    const page = this.#pageUrl(zoneId, encounterId, phase);
    const first = await this.#http.request(page, {
      headers: { Accept: DOCUMENT_ACCEPT },
      followRedirects: false,
    });

    if (first.status !== 302 || !(first.headers.get("location") ?? "").includes("human-challenge")) return;

    const challengeUrl = `https://${this.#config.host}/human-challenge`;
    const challenge = await this.#http.request(challengeUrl, { headers: { Accept: DOCUMENT_ACCEPT } });
    const token = /name="_token" value="([^"]+)"/.exec(challenge.body)?.[1];
    if (!token) fail("人机确认页面的结构发生了变化。");

    await this.#http.request(challengeUrl, {
      method: "POST",
      headers: { Accept: DOCUMENT_ACCEPT, Referer: challengeUrl, Origin: `https://${this.#config.host}` },
      body: new URLSearchParams({ _token: token }).toString(),
      followRedirects: false,
    });

    await this.#http.request(page, { headers: { Accept: DOCUMENT_ACCEPT } });
  }

  async #page(zoneId: number, encounterId: number, phase: number): Promise<string> {
    const url = this.#pageUrl(zoneId, encounterId, phase);
    const cached = this.#cache.get(url);
    if (cached !== null) return cached;

    await this.#ensureSession(zoneId, encounterId, phase);
    const response = await this.#http.request(url, { headers: { Accept: DOCUMENT_ACCEPT } });
    if (response.status !== 200) fail(`统计页返回 ${response.status}。`, `请求：${url}`);

    this.#cache.set(url, response.body);
    return response.body;
  }

  #pageUrl(zoneId: number, encounterId: number, phase: number): string {
    return `https://${this.#config.host}/zone/statistics/${zoneId}?boss=${encounterId}&phase=${phase}`;
  }
}

/** 各分位来自不同请求，极少数情况下会有毫厘倒挂，这里强制单调。 */
function monotonic(points: readonly Quantile[]): Quantile[] {
  const result: Quantile[] = [];
  let floor = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const value = Math.max(point.value, floor);
    result.push({ q: point.q, value });
    floor = value;
  }

  return result;
}

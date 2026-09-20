import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBars, parseDefaults, parseSpreads } from "./statistics-page.ts";

/**
 * 按统计页的真实结构手写的最小样张。
 *
 * 召唤师那一组是幻想龙诗 P2、rDPS、12 周窗口下的实际数值，
 * 因此这份用例同时也是“各字段究竟对应哪个分位”的书面证据。
 */
const BOXPLOT = `
<table cellspacing="0" class="summary-table" style="width:100%;">
<tbody>
	<tr>
		<td nowrap class="Summoner"><img class="table-icon"> 召唤师
		<td class="main-table-number primary">
6,278.00
<td class="main-table-number">
6,848.19
<td class="main-table-number">
350
</tr>
	<tr>
		<td nowrap class="Sage"><img class="table-icon"> 贤者
		<td class="main-table-number primary">
3,378.39
<td class="main-table-number">
3,769.85
<td class="main-table-number">
358
</tr>
</tbody>
</table>
<script>
var defaultPartition = 39;
obj = { difficulty: 100, sizes: [] };
obj.sizes.push(8);

var series = { name: "召唤师", data: [] };
series.color = setLineColorForActorFromType("Summoner");
if (useBars) {
	var q3 = 6277.9958203878;
	singleColumnSeries.data.push({ color: seriesColor, name: series.name,
		low: 4984.7641083464,
		q1: 5753.9076807933,
		median: 6031.9485345379,
		q3: q3,
		high: 6535.5992468322
	});
	singlePointSeries.data.push({ color: seriesColor, name: series.name, q3: q3, y: 6645.3872521741 });
}

var series = { name: "贤者", data: [] };
series.color = setLineColorForActorFromType("Sage");
if (useBars) {
	var q3 = 3378.3912345678;
	singleColumnSeries.data.push({ color: seriesColor, name: series.name,
		low: 2654.1111111111,
		q1: 3021.2222222222,
		median: 3207.3333333333,
		q3: q3,
		high: 3575.4444444444
	});
	singlePointSeries.data.push({ color: seriesColor, name: series.name, q3: q3, y: 3711.5555555555 });
}
</script>
`;

const SINGLE_DATASET = `
<script>
var series = { name: "召唤师", data: [] };
series.color = setLineColorForActorFromType("Summoner");
if (useBars) {
	singleColumnSeries.data.push({ name: series.name, color: seriesColor, y: 2217.4816543210 });
}

var series = { name: "贤者", data: [] };
series.color = setLineColorForActorFromType("Sage");
if (useBars) {
	singleColumnSeries.data.push({ name: series.name, color: seriesColor, y: 558.1234567890 });
}
</script>
`;

test("读出页面自带的分区与难度", () => {
  assert.deepEqual(parseDefaults(BOXPLOT), { partition: 39, difficulty: 100, size: 8 });
});

test("页面改版后读不出默认值时返回空", () => {
  assert.equal(parseDefaults("<html></html>"), null);
});

test("箱线图数据集给出五个分位、真最高值与样本量", () => {
  const spreads = parseSpreads(BOXPLOT);
  const summoner = spreads.get("Summoner");

  assert.ok(summoner);
  assert.equal(summoner.label, "召唤师");
  assert.equal(summoner.q25, 5753.9076807933);
  assert.equal(summoner.q50, 6031.9485345379);
  assert.equal(summoner.q75, 6277.9958203878);
  assert.equal(summoner.q95, 6535.5992468322);
  assert.equal(summoner.q99, 6645.3872521741);
  assert.equal(summoner.max, 6848.19);
  assert.equal(summoner.sampleSize, 350);
});

test("职业标识与数值不会串行", () => {
  const spreads = parseSpreads(BOXPLOT);
  assert.equal(spreads.size, 2);
  assert.equal(spreads.get("Sage")?.q50, 3207.3333333333);
  assert.equal(spreads.get("Sage")?.sampleSize, 358);
});

test("单分位数据集每个职业只取一个数值", () => {
  const bars = parseBars(SINGLE_DATASET);
  assert.equal(bars.get("Summoner"), 2217.481654321);
  assert.equal(bars.get("Sage"), 558.123456789);
});

test("无法辨认的页面不会抛错，只是解析为空", () => {
  assert.equal(parseSpreads("<html>什么都没有</html>").size, 0);
  assert.equal(parseBars("<html>什么都没有</html>").size, 0);
});
